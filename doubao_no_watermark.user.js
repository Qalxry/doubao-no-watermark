// ==UserScript==
// @name         豆包无水印图片下载
// @namespace    http://tampermonkey.net/
// @version      2.0.1
// @description  为豆包添加无水印图片下载功能（适配新版页面结构）
// @author       Qalxry,Zhanghuaimin-233
// @license      GPL-3.0
// @supportURL   https://github.com/Qalxry/doubao-no-watermark
// @icon         https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/web/logo-icon.png
// @match        https://*.doubao.com/*
// @grant        GM_xmlhttpRequest
// @connect      byteimg.com
// ==/UserScript==

(function () {
  "use strict";

  // ── GM 跨域请求，返回 Blob（绕过 CORS）─────────────────────────────────────
  function gmFetchBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        responseType: "blob",
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

  // ── 从右键点击的 img 元素提取 realImageInfo ─────────────────────────────────
  function getImageInfo(imgEl) {
    const fiberKey = Object.keys(imgEl).find(k => k.startsWith("__reactFiber"));
    if (!fiberKey) return null;
    let fiber = imgEl[fiberKey];
    let depth = 0;
    while (fiber && depth < 10) {
      const props = fiber.memoizedProps;
      if (props?.realImageInfo?.previewImage?.url && props?.realImageInfo?.downloadImage?.url) {
        return props.realImageInfo;
      }
      fiber = fiber.return;
      depth++;
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

  document.addEventListener("contextmenu", (e) => {
    if (!e.target.matches("img")) return;
    capturedImageInfo = getImageInfo(e.target);
    if (!capturedImageInfo) {
      console.warn("[无水印] 未能从 fiber 提取 realImageInfo");
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

  // ── 注入右键菜单项 ─────────────────────────────────────────────────────────
  const mo = new MutationObserver(() => {
    const menu = document.querySelector("div.semi-dropdown-content div");
    if (!menu || menu.querySelector(".tm-no-watermark-btn")) return;

    const existingItemClass =
      [...menu.querySelectorAll("div")].find(el => el.classList.length > 0)?.className || "";

    const btn = document.createElement("div");
    btn.className = `${existingItemClass} tm-no-watermark-btn`;
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
      下载无水印图片
    `;

    btn.addEventListener("click", async () => {
      if (!capturedImageInfo) {
        showToast("未捕获到图片信息，请确保在大图预览界面右键点击图片后再选择此项。<br/>聊天对话中的图片下载暂未支持。", 5000);
        return;
      }

      const urlA = capturedImageInfo.previewImage.url;  // pre_watermark，右下干净
      const urlB = capturedImageInfo.downloadImage.url; // dld_watermark，左上干净

      showToast("正在获取图片，请稍候…", 0);
      try {
        const [blobA, blobB] = await Promise.all([
          gmFetchBlob(urlA),
          gmFetchBlob(urlB),
        ]);

        showToast("正在合并图片…", 0);
        const merged = await mergeImages(blobA, blobB);

        const filename = `豆包无水印_${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
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