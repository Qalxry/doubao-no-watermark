// ==UserScript==
// @name         豆包无水印图片下载
// @namespace    http://tampermonkey.net/
// @version      1.0
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
     * 合并两张图片，用第2张图片的右下部分覆盖第1张图片的右下部分，这里假设两张图片大小相同
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

            function checkBothLoaded() {
                loadedCount++;
                if (loadedCount === 2 && !hasError) {
                    // Set canvas size to match the first image
                    canvas.width = img1.width;
                    canvas.height = img1.height;

                    // Draw the first image (base image)
                    ctx.drawImage(img1, 0, 0);

                    // Calculate the area to copy from the second image (bottom-right quarter)
                    const copyWidth = img2.width / 2;
                    const copyHeight = img2.height / 2;
                    const sourceX = img2.width / 2;
                    const sourceY = img2.height / 2;

                    // Calculate where to place it on the first image (bottom-right)
                    const destX = img1.width / 2;
                    const destY = img1.height / 2;

                    // Draw the bottom-right part of the second image onto the canvas
                    ctx.drawImage(img2, sourceX, sourceY, copyWidth, copyHeight, destX, destY, copyWidth, copyHeight);

                    // Convert canvas to blob
                    canvas.toBlob((blob) => {
                        if (blob) {
                            resolve(blob);
                        } else {
                            reject(new Error("无法生成图片"));
                        }
                    }, "image/png");
                }
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
                下载无水印图片
            `;

            downloadDiv.addEventListener("click", async () => {
                // 查找包含'复制'文本的div并点击
                const copyDiv = menu.querySelector('div[data-testid="right_click_copy_image"]');
                if (copyDiv) {
                    console.log("点击复制按钮");
                    copyDiv.click();

                    // 等待一下让复制操作完成
                    setTimeout(async () => {
                        try {
                            const clipboard = await navigator.clipboard.read();
                            const imageItem = clipboard.find(
                                (item) => item.types.includes("image/png") || item.types.includes("image/jpeg")
                            );
                            if (imageItem) {
                                const image1Blob = await imageItem.getType(
                                    imageItem.types.find((type) => type.startsWith("image/"))
                                );
                                const Image2Blob = await fetch(selectedImageUrl).then((res) => res.blob());
                                console.log("获取到图片1:", image1Blob);
                                console.log("获取到图片2:", Image2Blob);

                                // 这里可以调用合并图片的函数
                                const mergedImageBlob = await mergeImage(image1Blob, Image2Blob);
                                console.log("合并后的图片 Blob:", mergedImageBlob);

                                // 创建下载链接
                                const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
                                const url = URL.createObjectURL(mergedImageBlob);
                                const a = document.createElement("a");
                                a.style.display = "none";
                                a.href = url;
                                a.download = `豆包无水印_${timestamp}.png`;
                                a.click();
                                document.body.removeChild(a);
                                URL.revokeObjectURL(url);
                            } else {
                                console.log("剪贴板中没有找到图片");
                            }
                        } catch (err) {
                            console.error("读取剪贴板失败:", err);
                        }
                    }, 2000);
                }
            });

            menu.appendChild(downloadDiv);
        }
    });
    mo.observe(document.body, { childList: true });
})();
