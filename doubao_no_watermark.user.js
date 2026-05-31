// ==UserScript==
// @name         豆包无水印图片下载
// @namespace    http://tampermonkey.net/
// @version      2.1.1
// @description  为豆包添加无水印图片下载功能（适配新版 canvas 侧栏与图片消息结构）
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
    return new Promise((resolve, reject) => {
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

          // 底图：图A 全量（右下角无水印）
          ctx.drawImage(imgA, 0, 0);

          // 统一取整，避免奇数尺寸时浮点不一致
          const halfW = Math.ceil(imgA.width / 2);
          const halfH = Math.ceil(imgA.height / 2);

          // 清除左上区域，消除图A水印像素的影响
          ctx.clearRect(0, 0, halfW, halfH);

          // 用图B的左上 1/4 覆盖图A的左上 1/4
          if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
            showToast("图片尺寸不一致，正在缩放…");
            const tmp = document.createElement("canvas");
            tmp.width = imgA.width;
            tmp.height = imgA.height;
            tmp.getContext("2d").drawImage(imgB, 0, 0, imgA.width, imgA.height);
            ctx.drawImage(tmp, 0, 0, halfW, halfH, 0, 0, halfW, halfH);
          } else {
            ctx.drawImage(imgB,
              0, 0, halfW, halfH,
              0, 0, halfW, halfH
            );
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
      imgA.src = URL.createObjectURL(blobA);
      imgB.src = URL.createObjectURL(blobB);
    });
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
})();