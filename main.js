// ==UserScript==
// @name         豆包无水印图片下载
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  为豆包添加无水印图片下载功能
// @author       Qalxry
// @license      GPL-3.0
// @supportURL   https://github.com/Qalxry/doubao-no-watermark
// @icon         https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/web/logo-icon.png
// @match        https://*.doubao.com/*
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    let selectedImage = null;
    let selectedImageContainer = null;
    let selectedImageUrl = null;

    document.addEventListener(
        "contextmenu",
        (e) => {
            if (e.target.matches?.("img")) {
                selectedImage = e.target;
                // 向上找到第一个 class 为 "image-box-grid-item-{xxxxx} " 的 div
                let element = e.target;
                while (element && element !== document) {
                    if (
                        element.classList &&
                        element.classList.length &&
                        element.classList[0].startsWith("image-box-grid-item-")
                    ) {
                        selectedImageContainer = element;
                        break;
                    }
                    element = element.parentElement;
                }

                if (!selectedImageContainer) {
                    console.warn("未找到包含图片的容器，可能是页面结构发生了变化");
                    return;
                }
                const pngImage = selectedImageContainer.querySelector('img[data-testid="in_painting_picture"]');
                if (pngImage) {
                    selectedImageUrl = pngImage.src;
                    console.log("选中的图片 URL:", selectedImageUrl);
                } else {
                    console.warn("未找到完整图片，可能是页面结构发生了变化");
                    return;
                }
            }
        },
        true
    );
    /**
     * 合并两张图片，用第2张图片的右下部分覆盖第1张图片的右下部分
     * 如果第2张图片大小不等于第1张图片，则将第2张图片缩放至第1张图片大小
     * 并向body插入一个警告，说“该图片缓存已失效，请注意必须在图片刚生成的时候才能成功”
     * @param {Blob} image1_blob
     * @param {Blob} image2_blob
     */
    async function mergeImage(image1_blob, image2_blob) {
        return new Promise((resolve, reject) => {
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");

            const img1 = new Image();
            const img2 = new Image();

            let loadedCount = 0;
            let hasError = false;
            let needScale = false; // 标记是否需要缩放

            function checkBothLoaded() {
                loadedCount++;
                if (loadedCount === 2 && !hasError) {
                    // 检查图片尺寸是否相同
                    if (img1.width !== img2.width || img1.height !== img2.height) {
                        needScale = true;
                        // 插入警告
                        console.warn("图片尺寸不一致，正在尝试缩放第二张图片");
                        const warning = document.createElement("div");
                        warning.textContent = "该图片缓存已失效，请注意必须在图片刚生成的时候才能成功";
                        warning.style.cssText = `
                            position: fixed;
                            top: 50%;
                            left: 50%;
                            transform: translateX(-50%);
                            background: #ffcc00;
                            color: #000;
                            padding: 10px 20px;
                            border-radius: 5px;
                            z-index: 9999;
                            font-family: sans-serif;
                            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                            transition: opacity 0.3s ease;
                            opacity: 0;
                        `;
                        document.body.appendChild(warning);
                        warning.style.opacity = "1";

                        // 5秒后移除警告
                        setTimeout(() => {
                            warning.style.opacity = "0";
                            warning.style.pointerEvents = "none"; // 防止点击穿透
                            setTimeout(() => {
                                document.body.removeChild(warning);
                            }, 300); // 等待过渡效果结束后再移除
                        }, 5000);

                        // 创建临时canvas缩放img2
                        const scaleCanvas = document.createElement("canvas");
                        scaleCanvas.width = img1.width;
                        scaleCanvas.height = img1.height;
                        const scaleCtx = scaleCanvas.getContext("2d");

                        // 缩放绘制
                        scaleCtx.drawImage(img2, 0, 0, img1.width, img1.height);

                        // 将缩放后的图片转换为新的Image对象
                        scaleCanvas.toBlob((blob) => {
                            if (!blob) {
                                reject(new Error("缩放图片失败"));
                                return;
                            }

                            const scaledImg = new Image();
                            scaledImg.onload = () => {
                                // 使用缩放后的图片进行合并
                                performMerge(img1, scaledImg);
                            };
                            scaledImg.onerror = () => {
                                reject(new Error("加载缩放后的图片失败"));
                            };
                            scaledImg.src = URL.createObjectURL(blob);
                        }, "image/png");

                        return;
                    }

                    // 尺寸相同直接合并
                    performMerge(img1, img2);
                }
            }

            // 执行实际合并操作的函数
            function performMerge(baseImg, overlayImg) {
                canvas.width = baseImg.width;
                canvas.height = baseImg.height;

                // 绘制底图
                ctx.drawImage(baseImg, 0, 0);

                // 计算覆盖区域（右下1/4）
                const copyWidth = overlayImg.width / 2;
                const copyHeight = overlayImg.height / 2;
                const sourceX = overlayImg.width / 2;
                const sourceY = overlayImg.height / 2;
                const destX = baseImg.width / 2;
                const destY = baseImg.height / 2;

                // 覆盖右下角
                ctx.drawImage(overlayImg, sourceX, sourceY, copyWidth, copyHeight, destX, destY, copyWidth, copyHeight);

                // 转换为Blob
                canvas.toBlob((blob) => {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error("无法生成图片"));
                    }
                }, "image/png");
            }

            img1.onload = checkBothLoaded;
            img2.onload = checkBothLoaded;

            img1.onerror = () => {
                hasError = true;
                reject(new Error("加载第一张图片失败"));
            };

            img2.onerror = () => {
                hasError = true;
                reject(new Error("加载第二张图片失败"));
            };

            img1.src = URL.createObjectURL(image1_blob);
            img2.src = URL.createObjectURL(image2_blob);
        });
    }

    /* 轮询直到剪贴板出现图片 */
    async function waitForImageInClipboard(interval = 200, timeout = 10_000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                const items = await navigator.clipboard.read();
                const imgItem = items.find((it) => it.types.some((t) => t.startsWith("image/")));
                if (imgItem) {
                    return imgItem.getType(imgItem.types.find((t) => t.startsWith("image/")));
                }
            } catch {
                /* 忽略权限或空剪贴板错误 */
            }
            await new Promise((r) => setTimeout(r, interval));
        }
        throw new Error("未检测到剪贴板图片");
    }

    async function copyAndMerge(selectedImageUrl) {
        const copyDiv = document.querySelector('div[data-testid="right_click_copy_image"]');
        if (!copyDiv) return;

        /* 1. 同步清空剪贴板（必须在同一用户手势里） */
        // 构造一个空的 ClipboardItem，同步写进去
        const emptyItem = new ClipboardItem({ "text/plain": new Blob([""], { type: "text/plain" }) });
        await navigator.clipboard.write([emptyItem]);

        /* 2. 立即触发网页自己的复制按钮 */
        copyDiv.click();

        /* 3. 等待真正出现图片（此时一定是“新”图片） */
        const clipboardBlob = await waitForImageInClipboard(); // 轮询直到出现图片
        const netBlob = await fetch(selectedImageUrl).then((r) => r.blob());
        const mergedBlob = await mergeImage(clipboardBlob, netBlob);

        /* 4. 下载 */
        const url = URL.createObjectURL(mergedBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `豆包无水印_${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    const mo = new MutationObserver(() => {
        const menu = document.querySelector('div.semi-dropdown-content div[data-testid="image_context_menu"]');
        if (menu && !menu.querySelector(".tm-inject-selection")) {
            // 找同级第一个有 class 的 div
            const cls = [...menu.children].find((el) => el.classList.length)?.className || "";

            const downloadDiv = document.createElement("div");
            downloadDiv.className = `${cls} tm-inject-selection`;
            downloadDiv.style.color = "#ff6060";
            downloadDiv.innerHTML = `
                <span role="img" class="semi-icon semi-icon-default">
                  <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="none" viewBox="0 0 24 24">
                    <path fill="currentColor" d="M19.207 12.707a1 1 0 0 0-1.414-1.414L13 16.086V2a1 1 0 1 0-2 0v14.086l-4.793-4.793a1 1 0 0 0-1.414 1.414l6.5 6.5c.195.195.45.293.706.293H5a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2h-6.999a1 1 0 0 0 .706-.293z"/>
                  </svg>
                </span>
                下载无水印图片(仅适用于刚刚生成的图片)
            `;

            downloadDiv.addEventListener("click", async () => {
                if (!selectedImageUrl) {
                    console.warn("未选中图片或图片 URL 无效");
                    return;
                }
                try {
                    await copyAndMerge(selectedImageUrl);
                    console.log("下载成功");
                } catch (error) {
                    console.error("下载失败:", error);
                }
            });

            menu.appendChild(downloadDiv);
        }
    });
    mo.observe(document.body, { childList: true });
})();
