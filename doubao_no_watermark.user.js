// ==UserScript==
// @name         豆包无水印图片下载
// @namespace    http://tampermonkey.net/
// @version      2.2.0-experimental
// @description  为豆包添加无水印图片下载功能（适配新版 canvas 侧栏与图片消息结构）- 实验性模态框 UI
// @author       Qalxry,Zhanghuaimin-233
// @license      GPL-3.0
// @supportURL   https://github.com/Qalxry/doubao-no-watermark
// @icon         https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/web/logo-icon.png
// @match        https://*.doubao.com/*
// @grant        GM_xmlhttpRequest
// @connect      byteimg.com
// @connect      *.byteimg.com
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// ==/UserScript==

(function () {
  "use strict";

  // ── JSZip 动态加载回退 ─────────────────────────────────────────────────────
  function loadJSZip() {
    return new Promise((resolve, reject) => {
      if (typeof JSZip !== "undefined") return resolve();
      // 如果 unsafeWindow 上已有 JSZip（之前动态加载过），直接桥接到沙箱
      if (typeof unsafeWindow !== "undefined" && typeof unsafeWindow.JSZip !== "undefined") {
        window.JSZip = unsafeWindow.JSZip;
        console.log("[无水印] JSZip 从 unsafeWindow 桥接成功");
        return resolve();
      }
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
      const timer = setTimeout(() => reject(new Error("JSZip 加载超时")), 15000);
      script.onload = () => {
        clearTimeout(timer);
        console.log("[无水印] JSZip 动态加载成功");
        // 将页面上下文中的 JSZip 桥接到沙箱
        if (typeof JSZip === "undefined" && typeof unsafeWindow !== "undefined" && typeof unsafeWindow.JSZip !== "undefined") {
          window.JSZip = unsafeWindow.JSZip;
          console.log("[无水印] JSZip 已从页面上下文桥接到沙箱");
        }
        resolve();
      };
      script.onerror = () => { clearTimeout(timer); reject(new Error("JSZip 加载失败")); };
      document.head.appendChild(script);
    });
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

  function isObject(value) {
    return value !== null && typeof value === "object";
  }

  function isElement(value) {
    return isObject(value) && value.nodeType === 1;
  }

  function isFetchableImageUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url) && /byteimg\.com\//i.test(url);
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

  function extractImageKey(value) {
    if (!value) return "";
    const text = String(value);
    const noQuery = text.split("?")[0].split("~")[0];
    const tosIndex = noQuery.indexOf("tos-");
    if (tosIndex >= 0) return decodeURIComponent(noQuery.slice(tosIndex).replace(/^\/+/, ""));

    try {
      return decodeURIComponent(new URL(text, location.href).pathname.replace(/^\/+/, "").split("~")[0]);
    } catch (_) {
      return decodeURIComponent(noQuery.replace(/^\/+/, ""));
    }
  }

  function sameImageKey(a, b) {
    const keyA = extractImageKey(a);
    const keyB = extractImageKey(b);
    return Boolean(keyA && keyB && keyA === keyB);
  }

  function normalizeImageInfo(raw) {
    if (!isObject(raw)) return null;

    const source = raw.realImageInfo
      || raw.imageContent
      || raw.imageInfo
      || raw.image
      || raw.data
      || raw;

    if (!isObject(source)) return null;

    // 绘图侧栏：previewImage / downloadImage / thumbImage
    // 改图消息：preview_img / image_ori / image_thumb
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

    if (!previewImage?.url || !downloadImage?.url) return null;

    const key = source.key || raw.key || extractImageKey(previewImage.url) || extractImageKey(downloadImage.url);
    const width = firstNumber(source.width, raw.width, previewImage.width, downloadImage.width, thumbImage?.width);
    const height = firstNumber(source.height, raw.height, previewImage.height, downloadImage.height, thumbImage?.height);

    return {
      format: source.format || raw.format || downloadImage.format || previewImage.format || "",
      previewImage,
      downloadImage,
      thumbImage,
      width,
      height,
      otherFormat: source.otherFormat || raw.otherFormat || {},
      originalImage: toImageObject(source.originalImage) || toImageObject(source.image_raw) || previewImage,
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
    if (info) candidates.push({ info, path, objectDepth: depth });

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
        return rect.width >= 40 && rect.height >= 40 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
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
  const collectedImages = []; // 存储 { info, thumbnailUrl } 对象

  function getImageKeyForDedup(info) {
    return info?.key || extractImageKey(info?.previewImage?.url) || extractImageKey(info?.downloadImage?.url) || "";
  }

  function addCollectedImage(info) {
    if (!info?.previewImage?.url || !info?.downloadImage?.url) return false;
    const key = getImageKeyForDedup(info);
    if (!key) return false;
    if (collectedImages.some(item => getImageKeyForDedup(item.info) === key)) return false;
    collectedImages.push({ info, thumbnailUrl: info.previewImage.url });
    updateModalCount();
    return true;
  }

  function scanAndCollectImages() {
    const elements = [...document.querySelectorAll("canvas,img")]
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width >= 40 && rect.height >= 40;
      });

    for (const el of elements) {
      const info = getImageInfoFromElement(el, el.currentSrc || el.src || "");
      if (info) addCollectedImage(info);
    }
  }

  // 定期扫描 + MutationObserver 扫描
  let scanTimer = null;
  function startScanning() {
    if (scanTimer) return;
    scanTimer = setInterval(scanAndCollectImages, 3000);
    scanAndCollectImages();
  }

  const scanObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1 && (node.tagName === "IMG" || node.tagName === "CANVAS")) {
          setTimeout(scanAndCollectImages, 500);
          return;
        }
      }
    }
  });
  scanObserver.observe(document.body, { childList: true, subtree: true });
  startScanning();

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
    toastDiv.innerHTML = message;
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

  // ── 合并：底图=图A(pre)，用图B(dld)左上1/4覆盖 ────────────────────────────
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
    if (capturedImageInfo && Date.now() - capturedAt < 5 * 60 * 1000) return capturedImageInfo;
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

  function cloneMenuItemClass(menu) {
    const candidates = [...menu.querySelectorAll("div,[role='menuitem']")]
      .filter(el => !el.classList.contains("tm-no-watermark-btn") && (el.innerText || el.textContent || "").trim());
    return candidates.find(el => el.classList.length > 0)?.className || "";
  }

  // ── 注入右键菜单项 ─────────────────────────────────────────────────────────
  const mo = new MutationObserver(() => {
    if (!lastContextMenuHadImage && Date.now() - capturedAt > 1500) return;

    const menu = findContextMenuRoot();
    if (!menu || menu.querySelector(".tm-no-watermark-btn")) return;

    const existingItemClass = cloneMenuItemClass(menu);

    const btn = document.createElement("div");
    btn.className = `${existingItemClass} tm-no-watermark-btn`;
    btn.setAttribute("role", "menuitem");
    btn.style.cssText += "color:#ff6060;cursor:pointer;";
    btn.innerHTML = `
      <span role="img" style="margin-right:8px;display:inline-flex;vertical-align:middle;">
        <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.207 12.707a1 1 0 0 0-1.414-1.414L13 16.086V2a1 1 0 1 0-2 0v14.086
                   l-4.793-4.793a1 1 0 0 0-1.414 1.414l6.5 6.5c.195.195.45.293.706.293
                   H5a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2h-6.999a1 1 0 0 0 .706-.293z"/>
        </svg>
      </span>
      下载无水印图片
    `;

    btn.addEventListener("click", async () => {
      const imageInfo = getSelectedImageInfo();
      if (!imageInfo) {
        showToast("未捕获到图片信息。请在图片或右侧 canvas 大图上右键后再选择此项。", 5000);
        return;
      }

      const urlA = imageInfo.previewImage.url;  // pre_watermark，右下干净
      const urlB = imageInfo.downloadImage.url; // dld_watermark，左上干净
      if (!isFetchableImageUrl(urlA) || !isFetchableImageUrl(urlB)) {
        showToast("图片地址无效，无法下载。", 5000);
        console.warn("[无水印] 无效图片信息", imageInfo);
        return;
      }

      showToast("正在获取图片，请稍候…", 0);
      try {
        const [blobA, blobB] = await Promise.all([
          gmFetchBlob(urlA),
          gmFetchBlob(urlB),
        ]);

        showToast("正在合并图片…", 0);
        const merged = await mergeImages(blobA, blobB);

        const filename = getSafeFilename(imageInfo);
        downloadBlob(merged, filename);
        showToast("下载成功！");
      } catch (err) {
        console.error("[无水印下载]", err);
        showToast(`下载失败：${err.message}`);
      }
    });

    menu.appendChild(btn);
  });

  mo.observe(document.body, { childList: true, subtree: true });

  // ── 悬浮按钮 + 模态框 UI ──────────────────────────────────────────────────
  const NOMARK_BUTTON_HOST_ID = "doubao-nomark-button-host";
  const NOMARK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="none"/><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="M2.5 13.5v-7h19v7c0 3.771 0 5.657-1.172 6.828S17.272 21.5 13.5 21.5h-3c-3.771 0-5.657 0-6.828-1.172S2.5 17.271 2.5 13.5m0-7l.6-.8c1.178-1.57 1.767-2.355 2.611-2.778C6.556 2.5 7.537 2.5 9.5 2.5h5c1.963 0 2.944 0 3.789.422c.845.423 1.433 1.208 2.611 2.778l.6.8"/><path d="M15 14.5s-2.21 3-3 3s-3-3-3-3m3 2.5v-6.5"/></g></svg>`;

  let floatingBtnElement = null;
  let modalElement = null;

  function updateModalCount() {
    if (!floatingBtnElement) return;
    const countEl = floatingBtnElement.querySelector(".count");
    if (!countEl) return;
    const count = collectedImages.length;
    countEl.textContent = String(count);
    countEl.classList.toggle("show", count > 0);
  }

  function createFloatingButton() {
    const wrapper = document.createElement("div");
    wrapper.id = NOMARK_BUTTON_HOST_ID;
    wrapper.innerHTML = `
      <style>
        #${NOMARK_BUTTON_HOST_ID} {
          position: fixed; right: 24px; bottom: 24px; z-index: 2147483646;
          display: inline-flex; align-items: center; justify-content: center;
        }
        #doubao-nomark-btn {
          width: 48px; height: 48px; background: #ffffff; border: 1px solid #e0e0e0;
          border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);
          display: flex; align-items: center; justify-content: center; font-size: 20px;
          cursor: pointer; transition: border-color 0.2s ease, box-shadow 0.2s ease;
          position: relative; overflow: visible; color: #1f1f1f;
        }
        #doubao-nomark-btn:hover { border-color: #1f1f1f; box-shadow: 0 4px 12px rgba(0,0,0,0.12); }
        #doubao-nomark-btn .count {
          position: absolute; top: -7px; right: -6px; z-index: 1;
          display: none; min-width: 13px; height: 13px; padding: 0 3px;
          background: #ff4d4f; color: #ffffff; border-radius: 999px;
          font: 600 8px/13px sans-serif; align-items: center; justify-content: center;
          text-align: center; pointer-events: none; box-shadow: 0 0 0 1.5px #ffffff;
        }
        #doubao-nomark-btn .count.show { display: flex; }
      </style>
      <button id="doubao-nomark-btn" type="button" title="无水印图片管理">
        ${NOMARK_ICON_SVG}
        <span class="count" aria-live="polite">0</span>
      </button>
    `;
    document.body.appendChild(wrapper);
    floatingBtnElement = wrapper.querySelector("#doubao-nomark-btn");
    floatingBtnElement.addEventListener("click", openModal);
  }

  function openModal() {
    if (!modalElement) createModal();
    renderModalImages();
    modalElement.classList.add("show");
  }

  function closeModal() {
    if (modalElement) modalElement.classList.remove("show");
  }

  function createModal() {
    const modal = document.createElement("div");
    modal.id = "doubao-nomark-modal";
    modal.innerHTML = `
      <style>
        #doubao-nomark-modal {
          position: fixed; top: 0; left: 0; width: 100%; height: 100%;
          background: rgba(0,0,0,0.4); z-index: 10000; display: none;
          align-items: center; justify-content: center; animation: fadeIn 0.2s ease;
        }
        #doubao-nomark-modal.show { display: flex; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .nomark-modal-content {
          background: #ffffff; border-radius: 12px; width: 888px;
          max-width: calc(100vw - 48px); max-height: 85vh;
          display: flex; flex-direction: column; overflow: hidden;
          box-shadow: 0 8px 32px rgba(0,0,0,0.16);
          animation: slideUp 0.3s cubic-bezier(0.34,1.56,0.64,1);
          font-size: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .nomark-modal-topbar {
          padding: 10px 20px 0; border-bottom: 1px solid #e0e0e0;
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
        }
        .nomark-modal-actions { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
        .nomark-top-btn {
          height: 26px; padding: 0 8px; border: 1px solid #e0e0e0; border-radius: 6px;
          background: #ffffff; color: #1f1f1f; font-size: 12px; font-weight: 500;
          cursor: pointer; transition: all 0.2s ease; white-space: nowrap;
        }
        .nomark-top-btn:hover { background: #f7f7f7; border-color: #1f1f1f; }
        .nomark-top-btn.danger { background: #fff7ed; border-color: #fdba74; color: #9a3412; }
        .nomark-close-btn {
          width: 26px; height: 26px; background: transparent; border: 1px solid #e0e0e0;
          border-radius: 6px; cursor: pointer; display: flex; align-items: center;
          justify-content: center; color: #6b6b6b; font-size: 12px; transition: all 0.2s ease;
        }
        .nomark-close-btn:hover { background: #f7f7f7; border-color: #1f1f1f; color: #1f1f1f; }
        .nomark-modal-body { padding: 16px 20px; overflow-y: auto; flex: 1; }
        .nomark-modal-body::-webkit-scrollbar { width: 6px; }
        .nomark-modal-body::-webkit-scrollbar-track { background: transparent; }
        .nomark-modal-body::-webkit-scrollbar-thumb { background: #d0d0d0; border-radius: 3px; }
        .nomark-media-grid {
          --card-w: 160px; --preview-h: 160px;
          display: grid; grid-template-columns: repeat(5, var(--card-w));
          justify-content: start; gap: 12px;
        }
        .nomark-card {
          position: relative; border-radius: 8px; overflow: hidden;
          border: 1px solid #e0e0e0; background: #fafafa;
          transition: all 0.2s ease; display: flex; flex-direction: column;
        }
        .nomark-card:hover { border-color: #1f1f1f; }
        .nomark-preview {
          position: relative; width: 100%; height: var(--preview-h);
          display: block; background: #f0f0f0; cursor: pointer;
        }
        .nomark-preview img {
          width: 100%; height: var(--preview-h); object-fit: cover; display: block;
        }
        .nomark-info {
          position: absolute; top: 8px; right: 8px; padding: 3px 6px;
          background: rgba(0,0,0,0.6); border-radius: 4px; font-size: 12px;
          color: #ffffff; font-weight: 500; opacity: 0; transition: opacity 0.2s ease;
        }
        .nomark-card:hover .nomark-info { opacity: 1; }
        .nomark-actions {
          display: flex; align-items: center; gap: 6px; padding: 8px;
          background: #ffffff; border-top: 1px solid #e0e0e0;
        }
        .nomark-action-btn {
          flex: 0 0 auto; min-width: 52px; padding: 6px 10px;
          border: 1px solid #e0e0e0; border-radius: 4px; background: #ffffff;
          color: #1f1f1f; font-size: 12px; font-weight: 500; cursor: pointer;
          transition: all 0.2s ease;
        }
        .nomark-action-btn:hover { background: #f7f7f7; border-color: #1f1f1f; }
        .nomark-action-btn.success { background: #f0fdf4; border-color: #86efac; color: #166534; }
        .nomark-select {
          width: 14px; height: 14px; margin: 0 0 0 auto; accent-color: #1f1f1f; cursor: pointer;
        }
        .nomark-empty {
          text-align: center; padding: 56px 20px; color: #a0a0a0;
        }
        .nomark-empty-icon { font-size: 48px; margin-bottom: 12px; opacity: 0.5; }
        .nomark-empty-text { font-size: 12px; color: #6b6b6b; font-weight: 500; }
        .nomark-modal-footer {
          padding: 8px 20px; border-top: 1px solid #e0e0e0;
          display: flex; justify-content: center; align-items: center; gap: 8px;
          background: #fafafa;
        }
        .nomark-footer-text { color: #a0a0a0; font-size: 12px; }
        @media (max-width: 920px) {
          .nomark-modal-content { width: calc(100vw - 24px); }
          .nomark-media-grid { grid-template-columns: repeat(auto-fill, minmax(var(--card-w), var(--card-w))); }
        }
      </style>
      <div class="nomark-modal-content">
        <div class="nomark-modal-topbar">
          <div style="font-weight:600;font-size:14px;">无水印图片管理</div>
          <div class="nomark-modal-actions">
            <button class="nomark-top-btn btn-select-all" type="button">全选</button>
            <button class="nomark-top-btn btn-clear-selection" type="button">取消选择</button>
            <button class="nomark-top-btn btn-batch-download" type="button">批量下载</button>
            <button class="nomark-close-btn" type="button">×</button>
          </div>
        </div>
        <div class="nomark-modal-body">
          <div class="nomark-media-grid" id="nomark-media-container"></div>
        </div>
        <div class="nomark-modal-footer">
          <span class="nomark-footer-text">豆包无水印图片下载 · 实验性 UI</span>
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

    selectAllBtn.addEventListener("click", () => {
      container.querySelectorAll(".nomark-select").forEach(cb => cb.checked = true);
    });
    clearBtn.addEventListener("click", () => {
      container.querySelectorAll(".nomark-select").forEach(cb => cb.checked = false);
    });

    let batchDownloading = false;
    let batchCancel = false;

    batchBtn.addEventListener("click", async () => {
      if (batchDownloading) { batchCancel = true; return; }

      if (typeof JSZip === "undefined") {
        showToast("正在加载 JSZip…", 0);
        try {
          await loadJSZip();
        } catch (err) {
          showToast(`JSZip 加载失败：${err.message}`, 5000);
          return;
        }
      }

      const selected = [...container.querySelectorAll(".nomark-select:checked")];
      if (selected.length === 0) { showToast("请先选择要下载的图片", 3000); return; }

      console.log(`[无水印] 批量下载开始，共 ${selected.length} 张图片`);
      batchDownloading = true;
      batchCancel = false;
      batchBtn.textContent = "取消下载";
      batchBtn.classList.add("danger");

      const zip = new JSZip();
      console.log("[无水印] JSZip 实例创建成功");
      const folder = zip.folder("豆包无水印图片");
      let successCount = 0;
      const total = selected.length;

      for (let i = 0; i < selected.length; i++) {
        if (batchCancel) break;
        const cb = selected[i];
        const idx = parseInt(cb.dataset.index, 10);
        const item = collectedImages[idx];
        if (!item) continue;

        const card = cb.closest(".nomark-card");
        const dlBtn = card?.querySelector(".nomark-action-btn");
        if (dlBtn) dlBtn.textContent = `合并中 ${i + 1}/${total}`;

        try {
          console.log(`[无水印] 正在合并第 ${i + 1}/${total} 张图片…`);
          const blob = await Promise.race([
            mergeImageToBlob(item.info),
            new Promise((_, reject) => setTimeout(() => reject(new Error("图片合并超时(30s)")), 30000)),
          ]);
          const baseFilename = getSafeFilename(item.info);
          const ext = baseFilename.lastIndexOf(".");
          const filename = ext > 0
            ? `${baseFilename.slice(0, ext)}_${i + 1}${baseFilename.slice(ext)}`
            : `${baseFilename}_${i + 1}`;
          const arrayBuffer = await blob.arrayBuffer();
          folder.file(filename, arrayBuffer);
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
        console.log(`[无水印] 开始打包 ${successCount} 张图片…`);
        try {
          const zipUint8 = await zip.generateAsync({
            type: "uint8array",
            compression: "STORE",
            onUpdate: (meta) => {
              console.log(`[无水印] 打包进度: ${meta.percent.toFixed(1)}%`);
            },
          });
          console.log(`[无水印] generateAsync 完成，uint8 长度: ${zipUint8.length}`);
          const zipBlob = new Blob([zipUint8], { type: "application/zip" });
          console.log(`[无水印] 打包完成，zip 大小: ${(zipBlob.size / 1024).toFixed(1)} KB`);
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          downloadBlob(zipBlob, `豆包无水印图片_${timestamp}.zip`);
          showToast(`打包完成！共 ${successCount} 张图片`);
        } catch (err) {
          console.error("[无水印] 打包失败:", err);
          showToast(`打包失败：${err.message}`, 5000);
        }
      } else if (!batchCancel) {
        showToast("没有成功合并的图片", 3000);
      }

      batchDownloading = false;
      batchBtn.textContent = "批量下载";
      batchBtn.classList.remove("danger");
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

  async function downloadSingleImage(imageInfo) {
    const merged = await mergeImageToBlob(imageInfo);
    const filename = getSafeFilename(imageInfo);
    downloadBlob(merged, filename);
  }

  function renderModalImages() {
    const container = document.querySelector("#nomark-media-container");
    if (!container) return;

    if (collectedImages.length === 0) {
      container.innerHTML = `
        <div class="nomark-empty">
          <div class="nomark-empty-icon">🖼️</div>
          <div class="nomark-empty-text">暂未发现图片</div>
        </div>
      `;
      return;
    }

    container.innerHTML = collectedImages.map((item, index) => {
      const info = item.info;
      const resolution = (info.width && info.height) ? `${info.width} × ${info.height}` : "";
      return `
        <div class="nomark-card">
          <div class="nomark-preview">
            <img src="${item.thumbnailUrl}" alt="图片 ${index + 1}" loading="lazy">
            ${resolution ? `<div class="nomark-info">${resolution}</div>` : ""}
          </div>
          <div class="nomark-actions">
            <button class="nomark-action-btn" data-index="${index}">下载</button>
            <input class="nomark-select" type="checkbox" data-index="${index}" aria-label="选择图片 ${index + 1}">
          </div>
        </div>
      `;
    }).join("");

    container.querySelectorAll(".nomark-action-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        const item = collectedImages[idx];
        if (!item) return;

        btn.textContent = "下载中";
        try {
          await downloadSingleImage(item.info);
          btn.classList.add("success");
          btn.textContent = "✓ 已下载";
        } catch (err) {
          btn.textContent = "失败";
          showToast(`下载失败：${err.message}`, 3000);
        }
        setTimeout(() => { btn.classList.remove("success"); btn.textContent = "下载"; }, 2000);
      });
    });

    container.querySelectorAll(".nomark-preview img").forEach(img => {
      img.addEventListener("click", () => {
        const card = img.closest(".nomark-card");
        const cb = card?.querySelector(".nomark-select");
        if (cb) cb.checked = !cb.checked;
      });
    });
  }

  createFloatingButton();
})();