// ==UserScript==
// @name         豆包无水印图片下载
// @namespace    http://tampermonkey.net/
// @version      2.3.0
// @description  为豆包添加无水印图片下载功能（适配新版 canvas 侧栏与图片消息结构）- UI 重写版
// @author       Qalxry,Zhanghuaimin-233
// @license      GPL-3.0
// @supportURL   https://github.com/Qalxry/doubao-no-watermark
// @icon         https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/web/logo-icon.png
// @match        https://*.doubao.com/*
// @grant        GM_xmlhttpRequest
// @connect      byteimg.com
// @connect      *.byteimg.com
// ==/UserScript==

(function () {
  "use strict";

  // ── 脚本架构概述 ──────────────────────────────────────────────────────────
  // 1. ZIP 打包器：纯同步实现，不依赖 JSZip（豆包页面 polyfill 会卡死 JSZip）
  // 2. API 拦截：XHR 拦截 /im/chain/single（历史消息），Fetch 拦截 /chat/completion（实时生成）
  // 3. React Fiber 遍历：从 img/canvas 元素的 Fiber 树中提取 previewImage + downloadImage URL 对
  // 4. 图片合并去水印：previewImage（左上水印）+ downloadImage（右下水印）拼合为无水印图片
  // 5. 收集系统：DOM 扫描 + API 拦截双通道采集，按图片 key 去重，上限 200 条
  // 6. UI：悬浮按钮 + 管理面板（图片网格、模式切换、批量下载、定位跳转）

  // ── 最小化 ZIP 打包器（STORE 模式，无外部依赖）────────────────────────────
  // 纯同步实现，不受页面 polyfill 影响
  function buildZip(files) {
    // files: [{ name: string, data: Uint8Array }]
    const encoder = new TextEncoder();
    const entries = [];
    let offset = 0;

    // 1. 构建 local file headers + data
    const parts = [];
    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const nameLen = nameBytes.length;
      const dataLen = file.data.length;
      const crc = crc32(file.data);

      // local file header (30 + nameLen bytes)
      const header = new ArrayBuffer(30 + nameLen);
      const hv = new DataView(header);
      hv.setUint32(0, 0x04034b50, true);  // signature
      hv.setUint16(4, 20, true);           // version needed
      hv.setUint16(6, 0x0800, true);       // flags (bit 11 = UTF-8)
      hv.setUint16(8, 0, true);            // compression method (STORE)
      hv.setUint16(10, 0, true);           // mod time
      hv.setUint16(12, 0, true);           // mod date
      hv.setUint32(14, crc, true);         // crc32
      hv.setUint32(18, dataLen, true);     // compressed size
      hv.setUint32(22, dataLen, true);     // uncompressed size
      hv.setUint16(26, nameLen, true);     // filename length
      hv.setUint16(28, 0, true);           // extra field length
      new Uint8Array(header).set(nameBytes, 30);

      entries.push({ nameBytes, nameLen, dataLen, crc, offset });
      parts.push(new Uint8Array(header));
      parts.push(file.data);
      offset += 30 + nameLen + dataLen;
    }

    // 2. 构建 central directory
    const cdStart = offset;
    for (let i = 0; i < files.length; i++) {
      const e = entries[i];
      const cd = new ArrayBuffer(46 + e.nameLen);
      const dv = new DataView(cd);
      dv.setUint32(0, 0x02014b50, true);   // signature
      dv.setUint16(4, 20, true);            // version made by
      dv.setUint16(6, 20, true);            // version needed
      dv.setUint16(8, 0x0800, true);        // flags (bit 11 = UTF-8)
      dv.setUint16(10, 0, true);            // compression (STORE)
      dv.setUint16(12, 0, true);            // mod time
      dv.setUint16(14, 0, true);            // mod date
      dv.setUint32(16, e.crc, true);         // crc32
      dv.setUint32(20, e.dataLen, true);    // compressed
      dv.setUint32(24, e.dataLen, true);    // uncompressed
      dv.setUint16(28, e.nameLen, true);    // name len
      dv.setUint16(30, 0, true);            // extra len
      dv.setUint16(32, 0, true);            // comment len
      dv.setUint16(34, 0, true);            // disk number
      dv.setUint16(36, 0, true);            // internal attrs
      dv.setUint32(38, 0, true);            // external attrs
      dv.setUint32(42, e.offset, true);     // local header offset
      new Uint8Array(cd).set(e.nameBytes, 46);
      parts.push(new Uint8Array(cd));
      offset += 46 + e.nameLen;
    }
    const cdSize = offset - cdStart;

    // 3. end of central directory
    const eocd = new ArrayBuffer(22);
    const ev = new DataView(eocd);
    ev.setUint32(0, 0x06054b50, true);     // signature
    ev.setUint16(4, 0, true);              // disk number
    ev.setUint16(6, 0, true);              // disk with cd
    ev.setUint16(8, files.length, true);   // entries on this disk
    ev.setUint16(10, files.length, true);  // total entries
    ev.setUint32(12, cdSize, true);        // cd size
    ev.setUint32(16, cdStart, true);       // cd offset
    ev.setUint16(20, 0, true);             // comment length
    parts.push(new Uint8Array(eocd));

    // 合并所有部分
    const totalSize = parts.reduce((s, p) => s + p.length, 0);
    const result = new Uint8Array(totalSize);
    let pos = 0;
    for (const part of parts) {
      result.set(part, pos);
      pos += part.length;
    }
    return result;
  }

  // CRC32 查找表 + 计算
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
    return table;
  })();

  function crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // ── API 拦截 ──────────────────────────────────────────────────────────────
  // 双通道拦截解决懒加载问题：页面未滚动到的图片不会渲染到 DOM，
  // 但 API 响应中包含所有图片信息，拦截后可提前收集。
  // - XHR 拦截 /im/chain/single：获取历史聊天中的图片
  // - Fetch 拦截 /chat/completion：实时捕获生成中的图片（异步 clone 读取，不阻塞页面）
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this._nomark_url = url;
    return originalXHROpen.apply(this, [method, url, ...args]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const url = this._nomark_url || "";
        if (url.includes("/im/chain/single")) {
          const data = JSON.parse(this.responseText);
          // pull_singe_chain_downlink_body 是豆包 API 的原始字段名（singe 疑为 single 的拼写错误）
          const messages = data?.downlink_body?.pull_singe_chain_downlink_body?.messages;
          if (Array.isArray(messages)) {
            extractImagesFromMessages(messages);
          }
        }
      } catch (_) {}
    });
    return originalXHRSend.apply(this, args);
  };

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === "string" ? args[0] : "";
    const response = await originalFetch.apply(this, args);

    // 异步读取 clone，不阻塞页面接收原始 response
    if (url.includes("/chat/completion")) {
      readStreamForImages(response.clone());
    }

    return response;
  };

  async function readStreamForImages(response) {
    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              extractImagesFromStreamChunk(JSON.parse(line.substring(6)));
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }

  function extractImagesFromMessages(messages) {
    for (const msg of messages) {
      const msgId = msg.message_id || "";
      for (const block of (msg.content_block || [])) {
        const creations = block.content?.creation_block?.creations;
        if (!Array.isArray(creations)) continue;
        for (const creation of creations) {
          if (creation.image) addCollectedImageFromApi(creation.image, msgId);
        }
      }
    }
  }

  function extractImagesFromStreamChunk(json) {
    let creations = [];
    let streamMsgId = "";

    // 处理 patch_op 格式（初次生成）
    if (json.patch_op) {
      for (const op of json.patch_op) {
        const blocks = op.patch_value?.content_block;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            const c = block.content?.creation_block?.creations;
            if (Array.isArray(c)) creations.push(...c);
          }
        }
        const ext = op.patch_value?.ext?.creation_full_content;
        if (ext) {
          try {
            const parsed = JSON.parse(ext);
            for (const item of parsed) {
              const c = item?.BlockInfo?.BlockContent?.content?.creation_block?.creations;
              if (Array.isArray(c)) creations.push(...c);
            }
          } catch (_) {}
        }
      }
    }

    // 处理 event_data 格式（二次编辑）
    if (json.event_data) {
      try {
        const eventData = typeof json.event_data === "string" ? JSON.parse(json.event_data) : json.event_data;
        streamMsgId = eventData?.message_id || eventData?.message?.id || "";
        const content = eventData?.message?.content;
        if (content) {
          const parsed = typeof content === "string" ? JSON.parse(content) : content;
          if (Array.isArray(parsed.data)) {
            for (const item of parsed.data) {
              if (item.image_ori || item.image_thumb) {
                addCollectedImageFromApi(item, streamMsgId);
              }
            }
          }
          if (Array.isArray(parsed.creations)) {
            creations.push(...parsed.creations);
          }
        }
      } catch (_) {}
    }

    for (const creation of creations) {
      if (creation.image) addCollectedImageFromApi(creation.image, streamMsgId);
    }
  }

  function addCollectedImageFromApi(imageObj, messageId) {
    const info = normalizeImageInfo(imageObj);
    if (!info) return;
    // 提取 image_ori_raw 无水印直链（初次生成 API 可能包含此字段）
    const rawUrl = extractDirectUrl(imageObj);
    addCollectedImage(info, null, messageId, rawUrl);
  }

  function extractDirectUrl(obj) {
    if (!obj) return null;
    const candidates = [obj.image_ori_raw, obj.image_raw, obj.originalImage];
    for (const c of candidates) {
      if (typeof c === "string" && isFetchableImageUrl(c)) return c;
      if (c?.url && isFetchableImageUrl(c.url)) return c.url;
    }
    return null;
  }

  // ── GM 跨域请求，返回 Blob（绕过 CORS）─────────────────────────────────────
  function gmFetchBlob(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        fetch(url, { mode: "cors", credentials: "omit" })
          .then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.blob();
          })
          .then(resolve, reject);
        return;
      }

      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        responseType: "blob",
        timeout: 60000,
        onload: (res) => {
          if (res.status >= 200 && res.status < 400) {
            resolve(res.response);
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: (err) => reject(new Error("GM请求失败: " + JSON.stringify(err))),
        ontimeout: () => reject(new Error("请求超时")),
      });
    });
  }

  // ── 从 React Fiber 中提取图片信息（兼容 img / canvas / 绘图 / 改图）─────────────
  const FIBER_KEY_PREFIXES = ["__reactFiber", "__reactInternalInstance"];
  const MAX_FIBER_DEPTH = 45;
  const MAX_OBJECT_DEPTH = 7;
  const MAX_OBJECT_KEYS = 140;

  // ── 常量 ──────────────────────────────────────────────────────────────────
  const SCAN_INTERVAL_MS = 3000;           // 图片扫描间隔
  const CAPTURE_TTL_MS = 5 * 60 * 1000;   // 右键捕获的图片信息有效期
  const MERGE_TIMEOUT_MS = 30000;          // 单张图片合并超时
  const MIN_ELEMENT_SIZE = 40;             // 最小可扫描元素尺寸(px)

  function isObject(value) {
    return value !== null && typeof value === "object";
  }

  function isElement(value) {
    return isObject(value) && value.nodeType === 1;
  }

  function isFetchableImageUrl(url) {
    return typeof url === "string" && /^https:\/\/([a-z0-9-]+\.)?byteimg\.com\//i.test(url);
  }

  function toImageObject(value) {
    if (!value) return null;
    if (typeof value === "string") {
      return isFetchableImageUrl(value) ? { url: value } : null;
    }
    if (isObject(value) && isFetchableImageUrl(value.url)) {
      return {
        url: value.url,
        width: Number(value.width || value.w || 0) || undefined,
        height: Number(value.height || value.h || 0) || undefined,
        format: value.format || "",
      };
    }
    return null;
  }

  function pickImageObject(...values) {
    for (const value of values) {
      const image = toImageObject(value);
      if (image?.url) return image;
    }
    return null;
  }

  function firstNumber(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) return number;
    }
    return undefined;
  }

  function safeDecodeURIComponent(str) {
    try { return decodeURIComponent(str); } catch (_) { return str; }
  }

  function extractImageKey(value) {
    if (!value) return "";
    const text = String(value);
    const noQuery = text.split("?")[0].split("~")[0];
    const tosIndex = noQuery.indexOf("tos-");
    if (tosIndex >= 0) return safeDecodeURIComponent(noQuery.slice(tosIndex).replace(/^\/+/, ""));

    try {
      return safeDecodeURIComponent(new URL(text, location.href).pathname.replace(/^\/+/, "").split("~")[0]);
    } catch (_) {
      return safeDecodeURIComponent(noQuery.replace(/^\/+/, ""));
    }
  }

  function sameImageKey(a, b) {
    const keyA = extractImageKey(a);
    const keyB = extractImageKey(b);
    return Boolean(keyA && keyB && keyA === keyB);
  }

  // 将不同 API 响应格式统一为标准 imageInfo 结构
  // 豆包 API 返回格式随版本/场景变化，source 回退链兼容多种嵌套结构
  function normalizeImageInfo(raw) {
    if (!isObject(raw)) return null;

    // 优先级：realImageInfo（绘图侧栏）> imageContent > imageInfo > image > data > raw 自身
    const source = raw.realImageInfo
      || raw.imageContent
      || raw.imageInfo
      || raw.image
      || raw.data
      || raw;

    if (!isObject(source)) return null;

    // previewImage：水印在左上角，右下角干净（用于覆盖的底图）
    // downloadImage：水印在右下角，左上角干净（用于覆盖的补丁）
    // 两者合并即可去除水印。字段名因 API 版本而异，用 pickImageObject 依次尝试。
    const previewImage = pickImageObject(
      source.previewImage,
      source.preview_img,
      source.image_preview,
      source.imagePreview,
      source.preview,
      source.image_raw,
      source.originalImage,
      raw.previewImage,
      raw.preview_img,
      raw.image_preview,
    );

    const downloadImage = pickImageObject(
      source.downloadImage,
      source.download_img,
      source.image_ori,
      source.image_dld,
      source.image_download,
      source.download,
      raw.downloadImage,
      raw.download_img,
      raw.image_ori,
    );

    const thumbImage = pickImageObject(
      source.thumbImage,
      source.thumbnailImage,
      source.image_thumb,
      source.thumb,
      source.thumbnail,
      raw.thumbImage,
      raw.image_thumb,
    );

    // 二次编辑 API 只返回 image_thumb + image_ori，用 thumbImage 回退 previewImage
    const resolvedPreview = previewImage || thumbImage;
    if (!resolvedPreview?.url || !downloadImage?.url) return null;

    const key = source.key || raw.key || extractImageKey(resolvedPreview.url) || extractImageKey(downloadImage.url);
    const width = firstNumber(source.width, raw.width, resolvedPreview.width, downloadImage.width, thumbImage?.width);
    const height = firstNumber(source.height, raw.height, resolvedPreview.height, downloadImage.height, thumbImage?.height);

    return {
      format: source.format || raw.format || downloadImage.format || resolvedPreview.format || "",
      previewImage: resolvedPreview,
      downloadImage,
      thumbImage,
      width,
      height,
      otherFormat: source.otherFormat || raw.otherFormat || {},
      originalImage: toImageObject(source.originalImage) || toImageObject(source.image_raw) || resolvedPreview,
      key,
      downloadName: raw.downloadName || source.downloadName || raw.title || "",
    };
  }

  function shouldScanKey(key) {
    return /image|img|preview|download|thumb|ori|raw|real|content|message|creation|canvas|data|item|children|props|value/i.test(key);
  }

  function collectImageCandidates(value, candidates, path = "", depth = 0, seen = new WeakSet()) {
    if (!isObject(value) || isElement(value) || seen.has(value) || depth > MAX_OBJECT_DEPTH) return;
    seen.add(value);

    const info = normalizeImageInfo(value);
    if (info) candidates.push({ info, path, objectDepth: depth, raw: value });

    if (Array.isArray(value)) {
      value.slice(0, 24).forEach((item, index) => {
        collectImageCandidates(item, candidates, `${path}[${index}]`, depth + 1, seen);
      });
      return;
    }

    const keys = Object.keys(value).slice(0, MAX_OBJECT_KEYS);
    for (const key of keys) {
      if (!shouldScanKey(key)) continue;
      const child = value[key];
      if (!isObject(child) || typeof child === "function") continue;
      collectImageCandidates(child, candidates, path ? `${path}.${key}` : key, depth + 1, seen);
    }
  }

  function scoreImageCandidate(candidate, fiberDepth, targetUrl) {
    const info = candidate.info;
    let score = 1000 - fiberDepth * 15 - candidate.objectDepth * 3;

    if (candidate.path === "realImageInfo" || candidate.path.endsWith(".realImageInfo")) score += 220;
    if (/imageContent|imageEditorProps\.image|content_obj\.image_list|image_list/i.test(candidate.path)) score += 120;
    if (info.previewImage?.width >= 1000 || info.downloadImage?.width >= 1000 || info.width >= 1000) score += 30;

    if (targetUrl) {
      const urls = [info.previewImage?.url, info.downloadImage?.url, info.thumbImage?.url, info.originalImage?.url, info.key].filter(Boolean);
      if (urls.some(url => url === targetUrl || sameImageKey(url, targetUrl))) score += 900;
    }

    return score;
  }

  function getReactFiber(el) {
    if (!el) return null;
    const fiberKey = Object.keys(el).find(key => FIBER_KEY_PREFIXES.some(prefix => key.startsWith(prefix)));
    return fiberKey ? el[fiberKey] : null;
  }

  function getImageInfoFromElement(el, targetUrl = "") {
    const fiber = getReactFiber(el);
    if (!fiber) return null;

    let node = fiber;
    let depth = 0;
    let best = null;

    while (node && depth < MAX_FIBER_DEPTH) {
      const props = node.memoizedProps || node.pendingProps;
      if (props && isObject(props)) {
        const candidates = [];
        collectImageCandidates(props, candidates);
        for (const candidate of candidates) {
          const score = scoreImageCandidate(candidate, depth, targetUrl);
          if (!best || score > best.score) best = { ...candidate, score };
        }
      }
      node = node.return;
      depth++;
    }

    return best?.info || null;
  }

  function getEventPath(e) {
    if (typeof e.composedPath === "function") return e.composedPath();
    const path = [];
    let node = e.target;
    while (node) {
      path.push(node);
      node = node.parentNode;
    }
    return path;
  }

  function getImageInfoFromEvent(e) {
    const path = getEventPath(e).filter(node => isElement(node));
    const targetUrl = path
      .map(el => el.currentSrc || el.src || "")
      .find(Boolean) || "";

    for (const el of path) {
      const info = getImageInfoFromElement(el, targetUrl);
      if (info) return info;
    }

    return null;
  }

  function getBestVisibleImageInfo() {
    const elements = [...document.querySelectorAll("canvas,img")]
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width >= MIN_ELEMENT_SIZE && rect.height >= MIN_ELEMENT_SIZE && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      })
      .sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const canvasBias = (b.tagName === "CANVAS" ? 1e8 : 0) - (a.tagName === "CANVAS" ? 1e8 : 0);
        return canvasBias || (rb.width * rb.height - ra.width * ra.height);
      });

    for (const el of elements) {
      const info = getImageInfoFromElement(el, el.currentSrc || el.src || "");
      if (info) return info;
    }
    return null;
  }

  // ── 图片收集系统 ─────────────────────────────────────────────────────────
  const collectedImages = [];
  const collectedImagesMap = new Map(); // key → index, O(1) 去重
  const MAX_COLLECTED_IMAGES = 200;     // 容量上限，防内存泄漏

  function getImageKeyForDedup(info) {
    return info?.key || extractImageKey(info?.previewImage?.url) || extractImageKey(info?.downloadImage?.url) || "";
  }

  function addCollectedImage(info, element, messageId, directUrl) {
    if (!info?.previewImage?.url || !info?.downloadImage?.url) return false;
    const key = getImageKeyForDedup(info);
    if (!key) return false;
    const existingIdx = collectedImagesMap.get(key);
    if (existingIdx !== undefined) {
      const existing = collectedImages[existingIdx];
      if (element && !existing.element) existing.element = element;
      if (messageId && !existing.messageId) existing.messageId = messageId;
      if (directUrl && !existing.directUrl) existing.directUrl = directUrl;
      return false;
    }
    if (collectedImages.length >= MAX_COLLECTED_IMAGES) return false;
    collectedImagesMap.set(key, collectedImages.length);
    collectedImages.push({ info, thumbnailUrl: info.previewImage.url, element: element || null, messageId: messageId || null, directUrl: directUrl || null });
    updateModalCount();
    return true;
  }

  const scannedElements = new WeakSet(); // 跳过已处理元素，避免重复 Fiber 遍历

  function scanAndCollectImages() {
    const elements = [...document.querySelectorAll("canvas,img")]
      .filter(el => {
        if (scannedElements.has(el)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= MIN_ELEMENT_SIZE && rect.height >= MIN_ELEMENT_SIZE;
      });

    for (const el of elements) {
      scannedElements.add(el);
      const info = getImageInfoFromElement(el, el.currentSrc || el.src || "");
      if (info) {
        const directUrl = getDirectUrlFromElement(el);
        addCollectedImage(info, el, getMessageIdFromElement(el), directUrl);
      }
    }
  }

  // 从元素的 Fiber 数据中提取 image_ori_raw 等无水印直链
  function getDirectUrlFromElement(el) {
    const fiber = getReactFiber(el);
    if (!fiber) return null;
    let node = fiber;
    for (let depth = 0; node && depth < MAX_FIBER_DEPTH; depth++) {
      const props = node.memoizedProps || node.pendingProps;
      if (props && isObject(props)) {
        const url = extractDirectUrl(props);
        if (url) return url;
      }
      node = node.return;
    }
    return null;
  }

  // 从 DOM 元素向上遍历祖先，提取 messageId
  function getMessageIdFromElement(el) {
    let node = el;
    for (let i = 0; i < 15 && node; i++) {
      const row = node.dataset?.observeRow;
      if (row && row.startsWith("block_")) return row.replace("block_", "");
      const msgId = node.dataset?.messageId;
      if (msgId) return msgId;
      node = node.parentElement;
    }
    return null;
  }

  // 通过图片信息在当前 DOM 中查找匹配的元素
  function findElementByInfo(targetInfo) {
    if (!targetInfo) return null;
    const targetKey = getImageKeyForDedup(targetInfo);
    if (!targetKey) return null;
    const elements = document.querySelectorAll("canvas,img");
    for (const el of elements) {
      const info = getImageInfoFromElement(el, el.currentSrc || el.src || "");
      if (info && getImageKeyForDedup(info) === targetKey) return el;
    }
    return null;
  }

  // 通过虚拟列表内部 positionMap 精确滚动到指定消息
  // 注意：依赖豆包虚拟列表组件的内部实现（positionMap._sections），
  // 若豆包前端升级依赖版本此功能可能静默失效，不影响核心下载功能。
  function scrollToMessage(messageId) {
    if (!messageId) return false;
    const scroller = document.querySelector(".scroller");
    if (!scroller) return false;

    // 通过 React Fiber 获取虚拟列表实例
    const fiberKey = Object.keys(scroller).find(k => k.startsWith("__reactFiber"));
    if (!fiberKey) return false;
    let fiber = scroller[fiberKey];
    let vlist = null;
    for (let depth = 0; fiber && depth < 20; depth++) {
      const state = fiber.stateNode?.state;
      if (state?.positionMap?._sections) { vlist = fiber.stateNode; break; }
      fiber = fiber.return;
    }
    if (!vlist) return false;

    const sections = vlist.state.positionMap._sections;
    const target = sections.find(s => s.keys?.some(k => k.includes(messageId)));
    if (!target) return false;

    const headerEnd = vlist.state.positionMap._header?.end || 0;
    scroller.scrollTop = target.start - headerEnd;
    return true;
  }

  // 定期扫描 + MutationObserver 扫描 + URL 变化检测
  let scanTimer = null;
  let lastScanUrl = location.href;

  function checkUrlChange() {
    if (location.href !== lastScanUrl) {
      lastScanUrl = location.href;
      collectedImages.length = 0;
      collectedImagesMap.clear();
      updateModalCount();
      console.log("[无水印] 检测到页面切换，已清空图片缓存");
    }
  }

  function startScanning() {
    if (scanTimer) return;
    scanTimer = setInterval(() => {
      checkUrlChange();
      scanAndCollectImages();
    }, SCAN_INTERVAL_MS);
    scanAndCollectImages();
  }

  let scanDebounceTimer = null;
  const scanObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1 && (node.tagName === "IMG" || node.tagName === "CANVAS")) {
          if (scanDebounceTimer) clearTimeout(scanDebounceTimer);
          scanDebounceTimer = setTimeout(scanAndCollectImages, 500);
          return;
        }
      }
    }
  });
  if (document.body) {
    scanObserver.observe(document.body, { childList: true, subtree: true });
    startScanning();
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      scanObserver.observe(document.body, { childList: true, subtree: true });
      startScanning();
    });
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  const toastDiv = document.createElement("div");
  toastDiv.style.cssText = `
    position: fixed; top: 40%; left: 50%; transform: translateX(-50%);
    background: #fff8f8; color: #ff6060; padding: 10px 20px;
    border: 1px solid #ff6060; border-radius: 10px; z-index: 99999;
    font-family: sans-serif; box-shadow: 0 2px 10px rgba(0,0,0,0.2);
    transition: opacity 0.3s ease; display: none; text-align: center;
  `;
  document.body.appendChild(toastDiv);

  function showToast(message, duration = 3000) {
    toastDiv.textContent = message;
    clearTimeout(toastDiv._hideTimer);
    toastDiv.style.display = "block";
    toastDiv.style.opacity = "1";
    if (duration <= 0) return;
    toastDiv._hideTimer = setTimeout(() => {
      toastDiv.style.opacity = "0";
      toastDiv._hideTimer = setTimeout(() => {
        toastDiv.style.display = "none";
      }, 300);
    }, duration);
  }

  // ── 右键时捕获 imageInfo ────────────────────────────────────────────────────
  let capturedImageInfo = null;
  let capturedAt = 0;
  let lastContextMenuHadImage = false;

  document.addEventListener("contextmenu", (e) => {
    if (!e.target.closest?.("img,canvas")) {
      lastContextMenuHadImage = false;
      return;
    }

    lastContextMenuHadImage = true;
    capturedImageInfo = getImageInfoFromEvent(e);
    capturedAt = Date.now();
    if (!capturedImageInfo) {
      console.warn("[无水印] 未能从 fiber 提取图片信息", e.target);
    } else {
      console.info("[无水印] 已捕获图片信息", capturedImageInfo);
    }
  }, true);

  // 去水印原理：豆包有两套水印图
  // - previewImage (pre)：水印在左上角，右下角干净
  // - downloadImage (dld)：水印在右下角，左上角干净
  // 合并步骤：以 pre 为底图 → 清除左上 1/4 区域 → 用 dld 的左上 1/4 覆盖
  async function mergeImages(blobA, blobB) {
    const urlA = URL.createObjectURL(blobA);
    const urlB = URL.createObjectURL(blobB);
    try {
      return await new Promise((resolve, reject) => {
        const imgA = new Image();
        const imgB = new Image();
        let loaded = 0;

        function onLoad() {
          if (++loaded < 2) return;
          try {
            const canvas = document.createElement("canvas");
            canvas.width = imgA.width;
            canvas.height = imgA.height;
            const ctx = canvas.getContext("2d");

            ctx.drawImage(imgA, 0, 0);

            const halfW = Math.ceil(imgA.width / 2);
            const halfH = Math.ceil(imgA.height / 2);

            ctx.clearRect(0, 0, halfW, halfH);

            if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
              showToast("图片尺寸不一致，正在缩放…");
              const tmp = document.createElement("canvas");
              tmp.width = imgA.width;
              tmp.height = imgA.height;
              tmp.getContext("2d").drawImage(imgB, 0, 0, imgA.width, imgA.height);
              ctx.drawImage(tmp, 0, 0, halfW, halfH, 0, 0, halfW, halfH);
            } else {
              ctx.drawImage(imgB, 0, 0, halfW, halfH, 0, 0, halfW, halfH);
            }

            canvas.toBlob(blob => {
              blob ? resolve(blob) : reject(new Error("canvas.toBlob 失败"));
            }, "image/png");
          } catch (err) {
            reject(err);
          }
        }

        imgA.onload = onLoad;
        imgB.onload = onLoad;
        imgA.onerror = () => reject(new Error("加载图A失败"));
        imgB.onerror = () => reject(new Error("加载图B失败"));
        imgA.src = urlA;
        imgB.src = urlB;
      });
    } finally {
      URL.revokeObjectURL(urlA);
      URL.revokeObjectURL(urlB);
    }
  }

  // ── 下载 Blob ───────────────────────────────────────────────────────────────
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function getSafeFilename(info) {
    const rawName = info?.downloadName || document.title?.replace(/\s*-\s*豆包\s*$/, "") || "豆包无水印";
    const safeName = rawName.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 80) || "豆包无水印";
    return `${safeName}_无水印_${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  }

  function getSelectedImageInfo() {
    if (capturedImageInfo && Date.now() - capturedAt < CAPTURE_TTL_MS) return capturedImageInfo;
    const visibleInfo = getBestVisibleImageInfo();
    if (visibleInfo) {
      capturedImageInfo = visibleInfo;
      capturedAt = Date.now();
    }
    return visibleInfo;
  }

  function isVisibleElement(el) {
    return Boolean(el && (el.offsetParent !== null || el.getClientRects().length > 0));
  }

  function isDoubaoContextMenu(menu) {
    if (!menu) return false;

    // 豆包图片右键菜单目前是 Semi Dropdown + context-menu-*，
    // 普通模型/比例/分享菜单是 Radix role="menu"，不应注入。
    const contextRoot = menu.matches?.('[class*="context-menu-"]')
      ? menu
      : menu.querySelector?.('[class*="context-menu-"]');
    if (!contextRoot) return false;

    const text = (contextRoot.innerText || contextRoot.textContent || "").trim();
    return /下载原图|复制|引用/.test(text);
  }

  function findContextMenuRoot() {
    const semiMenus = [...document.querySelectorAll(".semi-dropdown-content")]
      .filter(isVisibleElement)
      .map(el => el.firstElementChild || el)
      .filter(isDoubaoContextMenu);

    return semiMenus.at(-1) || null;
  }

  function getMenuText(el) {
    return (el?.innerText || el?.textContent || "").replace(/\s+/g, "").trim();
  }

  function getContextMenuTemplateItem(menu) {
    const candidates = [...menu.querySelectorAll("div,[role='menuitem']")]
      .filter(el => !el.classList.contains("tm-no-watermark-btn") && isVisibleElement(el))
      .filter(el => {
        const text = getMenuText(el);
        // 避免选中包裹整个菜单的父元素，只拿真正的菜单行做模板
        return text && text.length <= 16;
      });
    return candidates.find(el => /下载原图/.test(getMenuText(el))) || candidates.find(el => el.classList.length > 0) || null;
  }

  function cloneMenuItemClass(menu) {
    return getContextMenuTemplateItem(menu)?.className || "";
  }

  function findDownloadOriginalMenuItem(menu) {
    return [...menu.querySelectorAll("div,[role='menuitem']")]
      .filter(el => !el.classList.contains("tm-no-watermark-btn") && isVisibleElement(el))
      .find(el => getMenuText(el) === "下载原图") || null;
  }

  function getCollectedItemByInfo(info) {
    if (!info) return null;
    const key = getImageKeyForDedup(info);
    if (!key) return null;
    return collectedImages.find(item => getImageKeyForDedup(item.info) === key) || null;
  }

  function getDirectUrlForInfo(info) {
    return getCollectedItemByInfo(info)?.directUrl || null;
  }

  // ── 注入右键菜单项 ─────────────────────────────────────────────────────────
  const menuObserver = new MutationObserver(() => {
    if (!lastContextMenuHadImage && Date.now() - capturedAt > 1500) return;

    const menu = findContextMenuRoot();
    if (!menu || menu.querySelector(".tm-no-watermark-btn")) return;

    const templateItem = findDownloadOriginalMenuItem(menu) || getContextMenuTemplateItem(menu);
    const existingItemClass = templateItem?.className || cloneMenuItemClass(menu);

    const btn = document.createElement("div");
    btn.className = `${existingItemClass || ""} tm-no-watermark-btn`.trim();
    btn.title = downloadMode === "direct"
      ? "当前模式：API 直链；如果该图片没有直链，会自动回退到重叠去水印"
      : "当前模式：重叠去水印";

    btn.style.color = "#ff6060";
    btn.style.cursor = "pointer";

    btn.innerHTML = `
      <span role="img" style="margin-right:8px;display:inline-flex;vertical-align:middle;">
        <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.207 12.707a1 1 0 0 0-1.414-1.414L13 16.086V2a1 1 0 1 0-2 0v14.086
                   l-4.793-4.793a1 1 0 0 0-1.414 1.414l6.5 6.5c.195.195.45.293.706.293
                   H5a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2h-6.999a1 1 0 0 0 .706-.293z"/>
        </svg>
      </span>
      下载无水印原图
    `;

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const imageInfo = getSelectedImageInfo();
      if (!imageInfo) {
        showToast("未捕获到图片信息。请在图片或右侧 canvas 大图上右键后再选择此项。", 5000);
        return;
      }

      try {
        // 右键菜单与图片管理弹窗共用 downloadMode。
        // 当模式为 API 直链但该图片没有 directUrl 时，downloadSingleImage 会自动回退到重叠合并。
        const directUrl = getDirectUrlForInfo(imageInfo);
        await downloadSingleImage(imageInfo, directUrl);
        showToast("下载成功！");
      } catch (err) {
        console.error("[无水印下载]", err);
        showToast(`下载失败：${err.message}`, 5000);
      }
    });

    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") btn.click();
    });

    if (templateItem?.parentElement) {
      templateItem.insertAdjacentElement("afterend", btn);
    } else {
      menu.appendChild(btn);
    }
  });

  if (document.body) {
    menuObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── 悬浮按钮 + 模态框 UI ──────────────────────────────
  // 说明：仅重写前端 UI 与交互状态，不改动图片扫描、合并、下载、ZIP 打包等核心逻辑。
  const NOMARK_BUTTON_HOST_ID = "doubao-nomark-button-host";
  const NOMARK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true"><path d="M0 0h24v24H0z" fill="none"/><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.65"><path d="M3 13.25v-6.5h18v6.5c0 3.62 0 5.43-1.12 6.55S16.95 20.92 13.33 20.92h-2.66c-3.62 0-5.43 0-6.55-1.12S3 16.87 3 13.25Z"/><path d="m3 6.75.56-.75c1.1-1.47 1.66-2.21 2.45-2.61C6.8 3 7.72 3 9.56 3h4.88c1.84 0 2.76 0 3.55.39.79.4 1.35 1.14 2.45 2.61l.56.75M15.1 13.75s-2.3 3.05-3.1 3.05-3.1-3.05-3.1-3.05M12 16.45v-6.3"/></g></svg>`;

  let floatingBtnElement = null;
  let modalElement = null;
  // 下载模式：右键菜单和模态框共用此状态
  // "overlay"：重叠去水印（合并 previewImage + downloadImage）
  // "direct"：API 直链（直接下载 image_ori_raw，无水印原图）
  // 直链模式下若图片无 directUrl，自动回退到重叠合并
  let downloadMode = "direct";
  let uiKeydownBound = false;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function cssUrl(value) {
    return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "");
  }

  function getUiStats() {
    const total = collectedImages.length;
    const direct = collectedImages.filter(item => item.directUrl).length;
    const locatable = collectedImages.filter(item => item.element || item.messageId).length;
    return { total, direct, locatable };
  }

  function updateModalCount() {
    const stats = getUiStats();

    if (floatingBtnElement) {
      const countEl = floatingBtnElement.querySelector(".count");
      if (countEl) {
        countEl.textContent = String(stats.total);
        countEl.classList.toggle("show", stats.total > 0);
      }
      floatingBtnElement.classList.toggle("has-images", stats.total > 0);
      floatingBtnElement.setAttribute("aria-label", `无水印图片管理，当前 ${stats.total} 张图片`);
    }

    if (modalElement) {
      const totalEl = modalElement.querySelector(".nomark-stat-total");
      const directEl = modalElement.querySelector(".nomark-stat-direct");
      const locateEl = modalElement.querySelector(".nomark-stat-locate");
      if (totalEl) totalEl.textContent = String(stats.total);
      if (directEl) directEl.textContent = String(stats.direct);
      if (locateEl) locateEl.textContent = String(stats.locatable);
      updateSelectedCount();
    }
  }

  function updateSelectedCount() {
    if (!modalElement) return;
    const selectedCount = modalElement.querySelectorAll(".nomark-select:checked").length;
    const selectedEl = modalElement.querySelector(".nomark-selected-count");
    const batchBtn = modalElement.querySelector(".btn-batch-download");
    if (selectedEl) selectedEl.textContent = String(selectedCount);
    if (batchBtn && !batchBtn.dataset.busy) {
      batchBtn.textContent = selectedCount > 0 ? `批量下载 ${selectedCount}` : "批量下载";
    }
  }

  function setCardSelected(checkbox) {
    const card = checkbox?.closest?.(".nomark-card");
    if (card) card.classList.toggle("selected", checkbox.checked);
    updateSelectedCount();
  }

  function createFloatingButton() {
    const wrapper = document.createElement("div");
    wrapper.id = NOMARK_BUTTON_HOST_ID;
    wrapper.innerHTML = `
      <style>
        #${NOMARK_BUTTON_HOST_ID} {
          --nomark-accent: #ff6060;
          --nomark-accent-2: #ff9a9a;
          --nomark-ink: #1f2937;
          --nomark-muted: #6b7280;
          --nomark-border: rgba(229, 231, 235, 0.92);
          --nomark-glass: rgba(255, 255, 255, 0.92);
          position: fixed;
          right: 24px;
          bottom: 24px;
          z-index: 2147483646;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        }
        #doubao-nomark-btn {
          position: relative;
          width: 54px;
          height: 54px;
          border: 1px solid var(--nomark-border);
          border-radius: 18px;
          color: var(--nomark-ink);
          background:
            radial-gradient(circle at 28% 18%, rgba(255, 96, 96, 0.16), transparent 28%),
            var(--nomark-glass);
          box-shadow: 0 16px 38px rgba(15, 23, 42, 0.14);
          backdrop-filter: blur(18px);
          -webkit-backdrop-filter: blur(18px);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 23px;
          cursor: pointer;
          outline: none;
          overflow: visible;
          transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease, color .18s ease, background .18s ease;
        }
        #doubao-nomark-btn:hover {
          transform: translateY(-2px) scale(1.02);
          color: var(--nomark-accent);
          border-color: rgba(255, 96, 96, 0.42);
          box-shadow: 0 22px 46px rgba(255, 96, 96, 0.20), 0 12px 28px rgba(15, 23, 42, 0.12);
        }
        #doubao-nomark-btn:active { transform: translateY(0) scale(.98); }
        #doubao-nomark-btn.has-images::after {
          content: "";
          position: absolute;
          inset: -5px;
          border-radius: 22px;
          border: 1px solid rgba(255, 96, 96, .26);
          animation: nomarkPulse 1.8s ease-out infinite;
          pointer-events: none;
        }
        @keyframes nomarkPulse {
          0% { opacity: .70; transform: scale(.96); }
          100% { opacity: 0; transform: scale(1.16); }
        }
        #doubao-nomark-btn .count {
          position: absolute;
          top: -7px;
          right: -7px;
          z-index: 1;
          display: none;
          min-width: 19px;
          height: 19px;
          padding: 0 6px;
          border-radius: 999px;
          background: linear-gradient(135deg, var(--nomark-accent), var(--nomark-accent-2));
          color: #fff;
          font: 800 10px/19px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          text-align: center;
          pointer-events: none;
          box-shadow: 0 0 0 2px #fff, 0 8px 16px rgba(255, 96, 96, .34);
        }
        #doubao-nomark-btn .count.show { display: block; }
      </style>
      <button id="doubao-nomark-btn" type="button" title="无水印图片管理" aria-label="无水印图片管理">
        ${NOMARK_ICON_SVG}
        <span class="count" aria-live="polite">0</span>
      </button>
    `;
    document.body.appendChild(wrapper);
    floatingBtnElement = wrapper.querySelector("#doubao-nomark-btn");
    floatingBtnElement.addEventListener("click", openModal);
    updateModalCount();
  }

  function openModal() {
    if (!modalElement) createModal();
    renderModalImages();
    modalElement.classList.add("show");
    document.documentElement.classList.add("doubao-nomark-modal-open");
    updateModalCount();
  }

  function closeModal() {
    if (!modalElement) return;
    modalElement.classList.remove("show");
    document.documentElement.classList.remove("doubao-nomark-modal-open");
  }

  function createModal() {
    const modal = document.createElement("div");
    modal.id = "doubao-nomark-modal";
    modal.innerHTML = `
      <style>
        #doubao-nomark-modal {
          --nomark-accent: #ff6060;
          --nomark-accent-2: #ff9a9a;
          --nomark-accent-soft: #fff1f1;
          --nomark-ink: #1f2937;
          --nomark-muted: #6b7280;
          --nomark-soft: #f6f7f9;
          --nomark-border: rgba(229, 231, 235, 0.92);
          --nomark-card: rgba(255, 255, 255, 0.96);
          position: fixed;
          inset: 0;
          z-index: 2147483645;
          display: none;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: rgba(15, 23, 42, 0.42);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
          color: var(--nomark-ink);
          animation: nomarkFadeIn .18s ease both;
        }
        #doubao-nomark-modal.show { display: flex; }
        @keyframes nomarkFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes nomarkSlideUp {
          from { opacity: 0; transform: translateY(22px) scale(.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .nomark-modal-content {
          width: min(960px, calc(100vw - 48px));
          max-height: min(86vh, 760px);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border-radius: 24px;
          border: 1px solid rgba(255, 255, 255, 0.68);
          background:
            radial-gradient(circle at 12% 0%, rgba(255, 96, 96, .11), transparent 32%),
            radial-gradient(circle at 84% 10%, rgba(124, 58, 237, .08), transparent 30%),
            rgba(255, 255, 255, 0.94);
          box-shadow: 0 30px 80px rgba(15, 23, 42, 0.24);
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
          animation: nomarkSlideUp .28s cubic-bezier(.34, 1.56, .64, 1) both;
        }
        .nomark-modal-topbar {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          padding: 18px 20px 14px;
          border-bottom: 1px solid var(--nomark-border);
          background: linear-gradient(180deg, rgba(255, 255, 255, .92), rgba(255, 255, 255, .72));
        }
        .nomark-title-area {
          min-width: 0;
          display: grid;
          gap: 12px;
        }
        .nomark-title-line {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
        }
        .nomark-title-icon {
          flex: 0 0 auto;
          width: 38px;
          height: 38px;
          border-radius: 15px;
          display: grid;
          place-items: center;
          color: #fff;
          font-size: 18px;
          background: linear-gradient(135deg, var(--nomark-accent), var(--nomark-accent-2));
          box-shadow: 0 12px 24px rgba(255, 96, 96, .26);
        }
        .nomark-title-text { min-width: 0; }
        .nomark-title-main {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 16px;
          line-height: 1.2;
          font-weight: 850;
          letter-spacing: .01em;
          white-space: nowrap;
        }
        .nomark-title-sub {
          margin-top: 5px;
          color: var(--nomark-muted);
          font-size: 12px;
          line-height: 1.45;
        }
        .nomark-stat-row {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 8px;
        }
        .nomark-stat-card {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          min-height: 28px;
          padding: 0 10px;
          border: 1px solid var(--nomark-border);
          border-radius: 999px;
          background: rgba(255, 255, 255, .78);
          color: var(--nomark-muted);
          font-size: 12px;
          font-weight: 700;
        }
        .nomark-stat-card strong { color: var(--nomark-ink); font-weight: 850; }
        .nomark-head-actions {
          display: grid;
          justify-items: end;
          gap: 10px;
          flex: 0 0 auto;
        }
        .nomark-mode-toggle {
          display: inline-flex;
          align-items: center;
          padding: 4px;
          border: 1px solid var(--nomark-border);
          border-radius: 999px;
          background: rgba(246, 247, 249, .88);
          gap: 3px;
        }
        .nomark-mode-btn {
          min-height: 30px;
          padding: 0 13px;
          border: none;
          border-radius: 999px;
          background: transparent;
          color: var(--nomark-muted);
          font-size: 12px;
          font-weight: 800;
          cursor: pointer;
          white-space: nowrap;
          transition: background .16s ease, color .16s ease, box-shadow .16s ease, transform .16s ease;
        }
        .nomark-mode-btn:hover:not(.active) { background: #fff; color: var(--nomark-ink); }
        .nomark-mode-btn.active {
          background: #1f2937;
          color: #fff;
          box-shadow: 0 9px 18px rgba(15, 23, 42, .18);
        }
        .nomark-modal-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 7px;
          flex-wrap: wrap;
        }
        .nomark-top-btn,
        .nomark-close-btn,
        .nomark-action-btn {
          appearance: none;
          font-family: inherit;
        }
        .nomark-top-btn {
          height: 32px;
          padding: 0 12px;
          border: 1px solid var(--nomark-border);
          border-radius: 999px;
          background: #fff;
          color: var(--nomark-ink);
          font-size: 12px;
          font-weight: 800;
          cursor: pointer;
          white-space: nowrap;
          transition: transform .16s ease, background .16s ease, color .16s ease, border-color .16s ease, box-shadow .16s ease;
        }
        .nomark-top-btn:hover {
          transform: translateY(-1px);
          border-color: rgba(255, 96, 96, .48);
          background: var(--nomark-accent-soft);
          color: var(--nomark-accent);
        }
        .nomark-top-btn.primary {
          color: #fff;
          border-color: transparent;
          background: linear-gradient(135deg, var(--nomark-accent), var(--nomark-accent-2));
          box-shadow: 0 10px 20px rgba(255, 96, 96, .22);
        }
        .nomark-top-btn.primary:hover {
          color: #fff;
          box-shadow: 0 14px 24px rgba(255, 96, 96, .28);
        }
        .nomark-top-btn.danger {
          color: #9a3412;
          border-color: #fdba74;
          background: #fff7ed;
          box-shadow: none;
        }
        .nomark-close-btn {
          width: 32px;
          height: 32px;
          border: 1px solid var(--nomark-border);
          border-radius: 999px;
          background: #fff;
          color: var(--nomark-muted);
          font-size: 18px;
          line-height: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: background .16s ease, color .16s ease, border-color .16s ease, transform .16s ease;
        }
        .nomark-close-btn:hover {
          transform: rotate(8deg);
          color: #fff;
          border-color: #1f2937;
          background: #1f2937;
        }
        .nomark-modal-body {
          flex: 1;
          min-height: 0;
          padding: 18px 20px;
          overflow-y: auto;
        }
        .nomark-modal-body::-webkit-scrollbar { width: 7px; }
        .nomark-modal-body::-webkit-scrollbar-track { background: transparent; }
        .nomark-modal-body::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 999px; }
        .nomark-media-grid {
          --card-w: 164px;
          --preview-h: 164px;
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(var(--card-w), 1fr));
          gap: 14px;
        }
        .nomark-card {
          position: relative;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border: 1px solid var(--nomark-border);
          border-radius: 20px;
          background: var(--nomark-card);
          box-shadow: 0 10px 22px rgba(15, 23, 42, .06);
          transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
        }
        .nomark-card:hover {
          transform: translateY(-2px);
          border-color: rgba(255, 96, 96, .52);
          box-shadow: 0 18px 38px rgba(15, 23, 42, .11);
        }
        .nomark-card.selected {
          border-color: rgba(255, 96, 96, .78);
          box-shadow: 0 0 0 3px rgba(255, 96, 96, .13), 0 18px 38px rgba(15, 23, 42, .10);
        }
        .nomark-preview {
          position: relative;
          width: 100%;
          height: var(--preview-h);
          overflow: hidden;
          display: block;
          cursor: pointer;
          background:
            linear-gradient(45deg, #f3f4f6 25%, transparent 25%),
            linear-gradient(-45deg, #f3f4f6 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, #f3f4f6 75%),
            linear-gradient(-45deg, transparent 75%, #f3f4f6 75%),
            #fff;
          background-size: 18px 18px;
          background-position: 0 0, 0 9px, 9px -9px, -9px 0;
        }
        .nomark-preview img {
          width: 100%;
          height: 100%;
          display: block;
          object-fit: cover;
          transition: transform .22s ease, filter .22s ease;
        }
        .nomark-card:hover .nomark-preview img { transform: scale(1.035); filter: saturate(1.04); }
        .nomark-info,
        .nomark-card-badge {
          position: absolute;
          z-index: 2;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 22px;
          padding: 0 8px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 850;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
        }
        .nomark-card-badge {
          top: 8px;
          left: 8px;
          background: rgba(255, 255, 255, .86);
          color: var(--nomark-accent);
          box-shadow: 0 8px 16px rgba(15, 23, 42, .10);
        }
        .nomark-info {
          top: 8px;
          right: 8px;
          max-width: calc(100% - 16px);
          background: rgba(15, 23, 42, .66);
          color: #fff;
          opacity: 0;
          transform: translateY(-3px);
          transition: opacity .18s ease, transform .18s ease;
        }
        .nomark-card:hover .nomark-info { opacity: 1; transform: translateY(0); }
        .nomark-preview-tip {
          position: absolute;
          left: 8px;
          right: 8px;
          bottom: 8px;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          opacity: 0;
          transform: translateY(6px);
          transition: opacity .18s ease, transform .18s ease;
        }
        .nomark-card:hover .nomark-preview-tip { opacity: 1; transform: translateY(0); }
        .nomark-preview-tip span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 100%;
          padding: 5px 8px;
          border-radius: 999px;
          background: rgba(255, 255, 255, .88);
          color: var(--nomark-ink);
          font-size: 11px;
          font-weight: 800;
          box-shadow: 0 8px 18px rgba(15, 23, 42, .10);
        }
        .nomark-actions {
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 10px;
          border-top: 1px solid var(--nomark-border);
          background: rgba(255, 255, 255, .92);
        }
        .nomark-action-btn {
          min-width: 54px;
          height: 30px;
          padding: 0 11px;
          border: 1px solid var(--nomark-border);
          border-radius: 999px;
          background: #fff;
          color: var(--nomark-ink);
          font-size: 12px;
          font-weight: 850;
          cursor: pointer;
          transition: background .16s ease, color .16s ease, border-color .16s ease, transform .16s ease;
        }
        .nomark-action-btn:hover {
          transform: translateY(-1px);
          border-color: rgba(255, 96, 96, .52);
          background: var(--nomark-accent-soft);
          color: var(--nomark-accent);
        }
        .nomark-action-btn.success {
          border-color: #86efac;
          background: #f0fdf4;
          color: #166534;
        }
        .nomark-action-btn:disabled,
        .nomark-action-btn:disabled:hover {
          transform: none;
          color: #b8bec8;
          border-color: #edf0f3;
          background: #f8fafc;
          cursor: not-allowed;
        }
        .nomark-select-wrap {
          margin-left: auto;
          position: relative;
          width: 20px;
          height: 20px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .nomark-select {
          width: 18px;
          height: 18px;
          margin: 0;
          accent-color: var(--nomark-accent);
          cursor: pointer;
        }
        .nomark-empty {
          grid-column: 1 / -1;
          min-height: 260px;
          display: grid;
          place-items: center;
          text-align: center;
          padding: 44px 20px;
          border: 1px dashed rgba(209, 213, 219, .95);
          border-radius: 22px;
          background: rgba(255, 255, 255, .72);
        }
        .nomark-empty-icon {
          width: 66px;
          height: 66px;
          margin: 0 auto 14px;
          display: grid;
          place-items: center;
          border-radius: 24px;
          background: var(--nomark-accent-soft);
          color: var(--nomark-accent);
          font-size: 32px;
        }
        .nomark-empty-text {
          color: var(--nomark-ink);
          font-size: 14px;
          font-weight: 850;
        }
        .nomark-empty-sub {
          max-width: 360px;
          margin: 8px auto 0;
          color: var(--nomark-muted);
          font-size: 12px;
          line-height: 1.7;
        }
        .nomark-modal-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 11px 20px;
          border-top: 1px solid var(--nomark-border);
          background: rgba(249, 250, 251, .78);
          color: #9ca3af;
          font-size: 12px;
        }
        .nomark-footer-left,
        .nomark-footer-right {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .nomark-kbd {
          min-width: 22px;
          height: 22px;
          padding: 0 7px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid var(--nomark-border);
          border-radius: 7px;
          background: #fff;
          color: var(--nomark-muted);
          font-size: 11px;
          font-weight: 800;
        }
        @media (max-width: 920px) {
          #doubao-nomark-modal { padding: 12px; }
          .nomark-modal-content { width: calc(100vw - 24px); max-height: 88vh; }
          .nomark-modal-topbar { flex-direction: column; align-items: stretch; }
          .nomark-head-actions { justify-items: stretch; }
          .nomark-modal-actions { justify-content: flex-start; }
          .nomark-title-line { align-items: flex-start; }
          .nomark-title-main { white-space: normal; }
          .nomark-media-grid { --card-w: 148px; --preview-h: 148px; }
        }
      </style>
      <div class="nomark-modal-content" role="dialog" aria-modal="true" aria-label="无水印图片管理">
        <div class="nomark-modal-topbar">
          <div class="nomark-title-area">
            <div class="nomark-title-line">
              <div class="nomark-title-icon">${NOMARK_ICON_SVG}</div>
              <div class="nomark-title-text">
                <div class="nomark-title-main">无水印图片管理</div>
                <div class="nomark-title-sub">右键菜单与管理面板共用去水印模式，API 直链不可用时会自动回退合并。</div>
              </div>
            </div>
            <div class="nomark-stat-row">
              <span class="nomark-stat-card">已收集 <strong class="nomark-stat-total">0</strong></span>
              <span class="nomark-stat-card">直链 <strong class="nomark-stat-direct">0</strong></span>
              <span class="nomark-stat-card">可定位 <strong class="nomark-stat-locate">0</strong></span>
              <span class="nomark-stat-card">已选择 <strong class="nomark-selected-count">0</strong></span>
            </div>
          </div>
          <div class="nomark-head-actions">
            <div class="nomark-mode-toggle" aria-label="下载模式切换">
              <button class="nomark-mode-btn ${downloadMode === "overlay" ? "active" : ""}" type="button" data-mode="overlay">重叠去水印</button>
              <button class="nomark-mode-btn ${downloadMode === "direct" ? "active" : ""}" type="button" data-mode="direct">API 直链</button>
            </div>
            <div class="nomark-modal-actions">
              <button class="nomark-top-btn btn-select-all" type="button">全选</button>
              <button class="nomark-top-btn btn-clear-selection" type="button">取消选择</button>
              <button class="nomark-top-btn primary btn-batch-download" type="button">批量下载</button>
              <button class="nomark-close-btn" type="button" title="关闭" aria-label="关闭">×</button>
            </div>
          </div>
        </div>
        <div class="nomark-modal-body">
          <div class="nomark-media-grid" id="nomark-media-container"></div>
        </div>
        <div class="nomark-modal-footer">
          <div class="nomark-footer-left">
            <span>提示：点击缩略图可以快速选择图片</span>
            <span style="margin-left:12px;color:#999;">由于页面加载机制，历史图片可能需要手动往上翻阅触发加载</span>
          </div>
          <div class="nomark-footer-right">
            <span class="nomark-kbd">Esc</span><span>关闭</span>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modalElement = modal;

    const container = modal.querySelector("#nomark-media-container");
    const selectAllBtn = modal.querySelector(".btn-select-all");
    const clearBtn = modal.querySelector(".btn-clear-selection");
    const batchBtn = modal.querySelector(".btn-batch-download");
    const closeBtn = modal.querySelector(".nomark-close-btn");

    closeBtn.addEventListener("click", closeModal);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

    if (!uiKeydownBound) {
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && modalElement?.classList.contains("show")) closeModal();
      });
      uiKeydownBound = true;
    }

    modal.querySelectorAll(".nomark-mode-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        downloadMode = btn.dataset.mode;
        modal.querySelectorAll(".nomark-mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === downloadMode));
        renderModalImages();
        showToast(downloadMode === "direct" ? "已切换为 API 直链模式" : "已切换为重叠去水印模式", 1800);
      });
    });

    selectAllBtn.addEventListener("click", () => {
      container.querySelectorAll(".nomark-select").forEach(cb => {
        cb.checked = true;
        setCardSelected(cb);
      });
    });

    clearBtn.addEventListener("click", () => {
      container.querySelectorAll(".nomark-select").forEach(cb => {
        cb.checked = false;
        setCardSelected(cb);
      });
    });

    let batchDownloading = false;
    let batchCancel = false;

    batchBtn.addEventListener("click", async () => {
      if (batchDownloading) { batchCancel = true; return; }

      const selected = [...container.querySelectorAll(".nomark-select:checked")];
      if (selected.length === 0) { showToast("请先选择要下载的图片", 3000); return; }

      console.log(`[无水印] 批量下载开始，共 ${selected.length} 张图片`);
      batchDownloading = true;
      batchCancel = false;
      batchBtn.dataset.busy = "1";
      batchBtn.textContent = "取消下载";
      batchBtn.classList.add("danger");
      batchBtn.classList.remove("primary");

      const zipFiles = [];
      let successCount = 0;
      const total = selected.length;

      for (let i = 0; i < selected.length; i++) {
        if (batchCancel) break;
        const cb = selected[i];
        const idx = parseInt(cb.dataset.index, 10);
        const item = collectedImages[idx];
        if (!item) continue;

        const card = cb.closest(".nomark-card");
        const dlBtn = card?.querySelector(".nomark-download-btn");
        if (dlBtn) dlBtn.textContent = `处理中 ${i + 1}/${total}`;

        try {
          const isDirect = downloadMode === "direct" && item.directUrl;
          if (dlBtn) dlBtn.textContent = isDirect ? `下载中 ${i + 1}/${total}` : `合并中 ${i + 1}/${total}`;
          console.log(`[无水印] 正在${isDirect ? "下载" : "合并"}第 ${i + 1}/${total} 张图片…`);
          if (i === 0) {
            if (isDirect) {
              showToast("批量下载：API 直链模式", 2000);
            } else if (downloadMode === "direct") {
              showToast("批量下载：部分图片无直链，回退到重叠合并", 2000);
            } else {
              showToast("批量下载：重叠去水印模式", 2000);
            }
          }
          let blob;
          if (isDirect) {
            blob = await gmFetchBlob(item.directUrl);
          } else {
            blob = await Promise.race([
              mergeImageToBlob(item.info),
              new Promise((_, reject) => setTimeout(() => reject(new Error("图片合并超时(30s)")), MERGE_TIMEOUT_MS)),
            ]);
          }
          const baseFilename = getSafeFilename(item.info);
          const ext = baseFilename.lastIndexOf(".");
          const filename = ext > 0
            ? `${baseFilename.slice(0, ext)}_${i + 1}${baseFilename.slice(ext)}`
            : `${baseFilename}_${i + 1}`;
          const arrayBuffer = await blob.arrayBuffer();
          zipFiles.push({ name: `豆包无水印图片/${filename}`, data: new Uint8Array(arrayBuffer) });
          successCount++;
          if (dlBtn) { dlBtn.classList.add("success"); dlBtn.textContent = `✓ ${successCount}/${total}`; }
        } catch (err) {
          if (dlBtn) dlBtn.textContent = "失败";
          console.error("[无水印] 批量下载失败:", err);
        }
      }

      console.log(`[无水印] 图片处理循环结束，成功 ${successCount}/${total}，batchCancel=${batchCancel}`);
      if (successCount > 0 && !batchCancel) {
        batchBtn.textContent = "打包中…";
        try {
          console.log(`[无水印] 开始打包 ${successCount} 张图片…`);
          const zipData = buildZip(zipFiles);
          console.log(`[无水印] 打包完成，zip 大小: ${(zipData.length / 1024).toFixed(1)} KB`);
          const zipBlob = new Blob([zipData], { type: "application/zip" });
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          downloadBlob(zipBlob, `豆包无水印图片_${timestamp}.zip`);
          showToast(`打包完成！共 ${successCount} 张图片`);
        } catch (err) {
          console.error("[无水印] 打包失败:", err);
          showToast(`打包失败：${err.message}`, 5000);
        }
      } else if (!batchCancel) {
        showToast("没有成功合并的图片", 3000);
      } else {
        showToast("已取消批量下载", 2000);
      }

      batchDownloading = false;
      batchBtn.dataset.busy = "";
      delete batchBtn.dataset.busy;
      batchBtn.textContent = "批量下载";
      batchBtn.classList.remove("danger");
      batchBtn.classList.add("primary");
      updateSelectedCount();
    });
  }

  async function mergeImageToBlob(imageInfo) {
    const urlA = imageInfo.previewImage.url;
    const urlB = imageInfo.downloadImage.url;
    if (!isFetchableImageUrl(urlA) || !isFetchableImageUrl(urlB)) {
      throw new Error("图片地址无效");
    }
    const [blobA, blobB] = await Promise.all([gmFetchBlob(urlA), gmFetchBlob(urlB)]);
    return mergeImages(blobA, blobB);
  }

  async function downloadSingleImage(imageInfo, directUrl) {
    let blob;
    if (downloadMode === "direct" && directUrl) {
      console.log("[无水印] 单图下载：API 直链模式", directUrl);
      showToast("正在通过 API 直链下载…");
      blob = await gmFetchBlob(directUrl);
    } else {
      if (downloadMode === "direct") {
        console.log("[无水印] 单图下载：无直链，回退到重叠合并");
        showToast("该图片无 API 直链，回退到重叠去水印…");
      } else {
        console.log("[无水印] 单图下载：重叠去水印模式");
        showToast("正在重叠合并去水印…");
      }
      blob = await mergeImageToBlob(imageInfo);
    }
    const filename = getSafeFilename(imageInfo);
    downloadBlob(blob, filename);
  }

  function renderModalImages() {
    const container = document.querySelector("#nomark-media-container");
    if (!container) return;

    updateModalCount();

    if (collectedImages.length === 0) {
      container.innerHTML = `
        <div class="nomark-empty">
          <div>
            <div class="nomark-empty-icon">🖼️</div>
            <div class="nomark-empty-text">暂未发现图片</div>
            <div class="nomark-empty-sub">请先在豆包页面生成或打开图片。插件会自动扫描当前页面，也可以在图片或右侧 canvas 大图上右键触发捕获。</div>
          </div>
        </div>
      `;
      updateSelectedCount();
      return;
    }

    container.innerHTML = collectedImages.map((item, index) => {
      const info = item.info;
      const resolution = (info.width && info.height) ? `${info.width} × ${info.height}` : "未知尺寸";
      const hasElement = Boolean(item.element || item.messageId);
      const hasDirect = Boolean(item.directUrl);
      const badge = downloadMode === "direct"
        ? (hasDirect ? "直链" : "回退")
        : "合并";
      const modeTip = downloadMode === "direct"
        ? (hasDirect ? "API 直链可用" : "无直链，将回退合并")
        : "重叠合并去水印";
      const alt = `图片 ${index + 1}`;
      return `
        <div class="nomark-card" data-index="${index}">
          <div class="nomark-preview" title="点击选择图片">
            <img src="${escapeHtml(item.thumbnailUrl)}" alt="${escapeHtml(alt)}" loading="lazy">
            <span class="nomark-card-badge">${escapeHtml(badge)}</span>
            <span class="nomark-info">${escapeHtml(resolution)}</span>
            <div class="nomark-preview-tip"><span>${escapeHtml(modeTip)}</span></div>
          </div>
          <div class="nomark-actions">
            <button class="nomark-action-btn nomark-download-btn" data-index="${index}">下载</button>
            <button class="nomark-action-btn btn-locate" data-index="${index}" ${hasElement ? "" : "disabled"}>定位</button>
            <label class="nomark-select-wrap" title="选择图片 ${index + 1}">
              <input class="nomark-select" type="checkbox" data-index="${index}" aria-label="选择图片 ${index + 1}">
            </label>
          </div>
        </div>
      `;
    }).join("");

    container.querySelectorAll(".nomark-select").forEach(cb => {
      cb.addEventListener("change", () => setCardSelected(cb));
    });

    container.querySelectorAll(".nomark-download-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        const item = collectedImages[idx];
        if (!item) return;

        btn.textContent = "下载中";
        btn.disabled = true;
        try {
          await downloadSingleImage(item.info, item.directUrl);
          btn.classList.add("success");
          btn.textContent = "✓ 已下载";
        } catch (err) {
          btn.textContent = "失败";
          showToast(`下载失败：${err.message}`, 3000);
        } finally {
          setTimeout(() => {
            btn.disabled = false;
            btn.classList.remove("success");
            btn.textContent = "下载";
          }, 2000);
        }
      });
    });

    container.querySelectorAll(".btn-locate").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        const item = collectedImages[idx];
        if (!item) return;

        closeModal();

        setTimeout(() => {
          const scrolled = item.messageId && scrollToMessage(item.messageId);
          const waitMs = scrolled ? 800 : 300;
          setTimeout(() => {
            const target = findElementByInfo(item.info) || (item.element?.isConnected ? item.element : null);
            if (target) {
              item.element = target;
              if (!scrolled) target.scrollIntoView({ behavior: "smooth", block: "center" });
              const orig = target.style.outline;
              const origOffset = target.style.outlineOffset;
              target.style.outline = "3px solid #ff6060";
              target.style.outlineOffset = "3px";
              setTimeout(() => {
                target.style.outline = orig;
                target.style.outlineOffset = origOffset;
              }, 2000);
            } else if (!scrolled) {
              showToast("图片当前未在页面中渲染", 3000);
            }
          }, waitMs);
        }, 200);
      });
    });

    container.querySelectorAll(".nomark-preview").forEach(preview => {
      preview.addEventListener("click", () => {
        const cb = preview.closest(".nomark-card")?.querySelector(".nomark-select");
        if (cb) {
          cb.checked = !cb.checked;
          setCardSelected(cb);
        }
      });
    });

    updateSelectedCount();
  }

  createFloatingButton();
})();
