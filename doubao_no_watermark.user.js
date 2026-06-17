// ==UserScript==
// @name         豆包无水印图片下载
// @namespace    http://tampermonkey.net/
// @version      2.3.1
// @description  为豆包添加无水印图片下载功能（适配新版 canvas 侧栏与图片消息结构）- UI 重写版
// @author       Qalxry,Zhanghuaimin-233
// @license      GPL-3.0
// @supportURL   https://github.com/Qalxry/doubao-no-watermark
// @icon         https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/web/logo-icon.png
// @match        https://*.doubao.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      byteimg.com
// @connect      *.byteimg.com
// ==/UserScript==

(function () {
  "use strict";
  const pageWindow = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
  console.log("[无水印] 脚本开始执行");

  // ── 提示词库：配置与工具函数 ──────────────────────────────────────────────
  const PromptConfig = {
    STORAGE_KEY: 'promptManager.prompts',
    CATEGORIES_KEY: 'promptManager.categories',
    FREQUENT_ORDER_KEY: 'promptManager.frequentOrder',
    CAT_ORDER_KEY: 'promptManager.categoryOrder',
    HELP_SEEN_KEY: 'promptManager.helpSeen',
    DEFAULT_CATEGORIES: ['通用模板', '人物描述', '风格', '构图', '光影与质感', '负面提示词', '文字与签名'],
  };

  function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return escHtml(String(s)).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  // ── 提示词库：存储服务 ────────────────────────────────────────────────────
  const StorageService = {
    async load() {
      let prompts = (await GM_getValue(PromptConfig.STORAGE_KEY)) || [];
      let migrated = false;
      for (const p of prompts) {
        if (p.lastUsedAt === undefined) { p.lastUsedAt = null; migrated = true; }
        if (p.editedAt !== undefined) { delete p.editedAt; migrated = true; }
        if (p.sortOrder === undefined) { p.sortOrder = 0; migrated = true; }
      }
      if (migrated) {
        const sorted = [...prompts].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        sorted.forEach((p, i) => { p.sortOrder = i; });
        await GM_setValue(PromptConfig.STORAGE_KEY, prompts);
      }
      return prompts;
    },
    async save(prompts) {
      await GM_setValue(PromptConfig.STORAGE_KEY, prompts);
    },
    async loadCategories() {
      const stored = await GM_getValue(PromptConfig.CATEGORIES_KEY);
      if (stored && Array.isArray(stored)) return stored;
      await GM_setValue(PromptConfig.CATEGORIES_KEY, [...PromptConfig.DEFAULT_CATEGORIES]);
      return [...PromptConfig.DEFAULT_CATEGORIES];
    },
    async saveCategories(cats) {
      await GM_setValue(PromptConfig.CATEGORIES_KEY, cats);
    },
    async loadFrequentOrder() {
      return (await GM_getValue(PromptConfig.FREQUENT_ORDER_KEY)) || [];
    },
    async saveFrequentOrder(order) {
      await GM_setValue(PromptConfig.FREQUENT_ORDER_KEY, order);
    },
    async loadCategoryOrder() {
      return (await GM_getValue(PromptConfig.CAT_ORDER_KEY)) || [];
    },
    async saveCategoryOrder(order) {
      await GM_setValue(PromptConfig.CAT_ORDER_KEY, order);
    },
    exportJSON(prompts) {
      const exported = prompts.map(({ usageCount, lastUsedAt, sortOrder, ...rest }) => rest);
      const data = { app: 'Prompt Manager', schemaVersion: 1, exportedAt: new Date().toISOString(), prompts: exported };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `prompt-manager-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
    async importJSON(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const data = JSON.parse(reader.result);
            if (!data.prompts || !Array.isArray(data.prompts)) { reject(new Error('无效的提示词备份文件')); return; }
            resolve(data.prompts);
          } catch (e) { reject(new Error('文件解析失败')); }
        };
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsText(file);
      });
    },
  };

  // ── 提示词库：提示词服务 ──────────────────────────────────────────────────
  const PromptService = {
    create(data) {
      return {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title: data.title || '',
        content: data.content || '',
        category: data.category || '通用模板',
        tags: data.tags || [],
        favorite: false,
        usageCount: 0,
        sortOrder: data.sortOrder || 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastUsedAt: null,
      };
    },
    update(prompt, data) {
      return { ...prompt, ...data, updatedAt: new Date().toISOString() };
    },
    search(keyword, prompts) {
      if (!keyword) return prompts;
      const kw = keyword.toLowerCase();
      return prompts.filter(p =>
        p.title.toLowerCase().includes(kw) ||
        p.content.toLowerCase().includes(kw) ||
        (p.tags || []).some(t => t.toLowerCase().includes(kw))
      );
    },
    filterByCategory(category, prompts) {
      if (!category || category === '全部') return prompts;
      return prompts.filter(p => p.category === category);
    },
  };

  // ── 提示词库：模板变量系统 ────────────────────────────────────────────────
  function parseTemplate(template) {
    const variables = [];
    const seen = new Set();
    template.replace(/{([^{}]+)}/g, (_, inner) => {
      const eqIdx = inner.indexOf("=");
      const varName = (eqIdx > -1 ? inner.slice(0, eqIdx) : inner).trim();
      if (!seen.has(varName)) {
        seen.add(varName);
        const defaultVal = eqIdx > -1 ? inner.slice(eqIdx + 1).replace(/^['"‘“]|['"’”]$/g, "") : null;
        variables.push({ name: varName, defaultVal: defaultVal || null });
      }
      return "";
    });
    return variables;
  }

  function unwrapInput(text) {
    const s = text;
    if (s.length >= 2) {
      const o = s.charCodeAt(0);
      const c = s.charCodeAt(s.length - 1);
      if ((o === 39 && c === 39) || (o === 34 && c === 34) ||
        (o === 8216 && c === 8217) || (o === 8220 && c === 8221)) {
        return { raw: s.slice(1, -1) };
      }
    }
    return { error: "输入内容必须整体由一组成对引号包裹" };
  }

  function splitEscaped(raw) {
    if (raw === '') return [];
    return raw.split(/(?<!\\)\|/).map(s =>
      s.replace(/\\\|/g, '|').replace(/\\\\/g, '\\').replace(/\\n/g, '\n')
    );
  }

  function resolveArgs(variables, tokens) {
    const values = {};
    const occupied = new Set();
    const skipped = new Set();
    const errors = [];
    let pointer = 0;
    const varNames = new Set(variables.map(v => v.name));

    for (const token of tokens) {
      const eqIdx = token.indexOf('=');
      const isNamed = eqIdx > 0 && varNames.has(token.slice(0, eqIdx));

      if (isNamed) {
        const name = token.slice(0, eqIdx);
        const val = token.slice(eqIdx + 1);
        if (occupied.has(name)) { errors.push('变量「' + name + '」被重复赋值'); continue; }
        if (val === '') { skipped.add(name); occupied.add(name); }
        else { values[name] = val; occupied.add(name); }
      } else if (eqIdx > 0 && /^[a-zA-Z0-9_一-鿿㐀-䶿]+$/.test(token.slice(0, eqIdx))) {
        errors.push('未知变量「' + token.slice(0, eqIdx) + '」，模板中不存在该变量');
      } else {
        while (pointer < variables.length && occupied.has(variables[pointer].name)) pointer++;
        if (pointer >= variables.length) { errors.push("顺序参数过多，多余：「" + token + "」"); continue; }
        const v = variables[pointer];
        if (token === "") { skipped.add(v.name); occupied.add(v.name); }
        else { values[v.name] = token; occupied.add(v.name); }
        pointer++;
      }
    }
    return { values, skipped, occupied, errors };
  }

  function fillTemplate(template, variables, result) {
    if (!result) return template;
    return template.replace(/{([^{}]+)}/g, (fullMatch, inner) => {
      const eqIdx = inner.indexOf("=");
      const varName = (eqIdx > -1 ? inner.slice(0, eqIdx) : inner).trim();
      const defaultVal = eqIdx > -1 ? inner.slice(eqIdx + 1).replace(/^['"‘“]|['"’”]$/g, "") : null;
      if (varName in result.values) return result.values[varName];
      if (result.skipped.has(varName) && defaultVal) return defaultVal;
      if (defaultVal) return defaultVal;
      return fullMatch;
    });
  }

  // ── 提示词库：豆包输入框适配器 ──────────────────────────────────────────
  const SiteAdapter = {
    _editorEl: null,

    _isVisible(el) {
      return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    },

    _isOwnUi(el) {
      return !!el?.closest?.('#doubao-nomark-modal, #doubao-prompt-modal, .pm-modal-overlay, .pm-panel, .pm-fab');
    },

    _findEditor() {
      // 豆包输入框探测：按优先级尝试
      const doc = pageWindow.document || document;
      const isTarget = el => this._isVisible(el) && !this._isOwnUi(el);
      const doubaoTextarea = [...doc.querySelectorAll('textarea')]
        .find(el => isTarget(el) && (el.placeholder || '').includes('发消息'));
      if (doubaoTextarea) return { type: 'textarea', el: doubaoTextarea };
      // 1. contenteditable div（豆包常用）
      const editable = [...doc.querySelectorAll('[contenteditable="true"]')].find(isTarget);
      if (editable) return { type: 'contenteditable', el: editable };
      // 2. textarea
      const ta = [...doc.querySelectorAll('textarea')].find(isTarget);
      if (ta) return { type: 'textarea', el: ta };
      // 3. 带 role="textbox" 的元素
      const textbox = [...doc.querySelectorAll('[role="textbox"]')].find(isTarget);
      if (textbox) return { type: 'contenteditable', el: textbox };
      return null;
    },

    getEditor() {
      if (this._editorEl && this._editorEl.el?.isConnected && this._isVisible(this._editorEl.el) && !this._isOwnUi(this._editorEl.el)) return this._editorEl;
      this._editorEl = this._findEditor();
      return this._editorEl;
    },

    getInputText() {
      const editor = this.getEditor();
      if (!editor) return '';
      if (editor.type === 'textarea') return editor.el.value;
      return editor.el.textContent || '';
    },

    _dispatchTextareaInput(el, data, inputType = 'insertText') {
      const InputEventCtor = pageWindow.InputEvent || InputEvent;
      const EventCtor = pageWindow.Event || Event;
      let inputEvent;
      try {
        inputEvent = new InputEventCtor('input', { bubbles: true, cancelable: true, inputType, data });
      } catch (e) {
        inputEvent = new EventCtor('input', { bubbles: true, cancelable: true });
      }
      el.dispatchEvent(inputEvent);
      el.dispatchEvent(new EventCtor('change', { bubbles: true }));
    },

    _setTextareaValue(el, value, data = value, inputType = 'insertText') {
      const TextareaCtor = pageWindow.HTMLTextAreaElement || HTMLTextAreaElement;
      const nativeSetter = Object.getOwnPropertyDescriptor(TextareaCtor.prototype, 'value')?.set;
      el.focus();
      if (nativeSetter) nativeSetter.call(el, value);
      else el.value = value;
      if (typeof el.setSelectionRange === 'function') el.setSelectionRange(value.length, value.length);
      this._dispatchTextareaInput(el, data, inputType);
    },

    findSendButton() {
      const doc = pageWindow.document || document;
      const editor = this.getEditor();
      const scopes = [
        editor?.el?.closest?.('.input-content-container-bMefgL'),
        editor?.el?.closest?.('[class*="input-content-container"]'),
        editor?.el?.closest?.('[class*="input-guidance"]'),
        doc,
      ].filter(Boolean);
      const selectors = [
        '.send-btn-wrapper button',
        '[data-testid="send-button"]',
        'button[class*="send"]',
        'button[class*="submit"]',
        'button[type="submit"]',
      ];
      for (const scope of scopes) {
        for (const selector of selectors) {
          const btn = [...scope.querySelectorAll(selector)].find(el =>
            this._isVisible(el) &&
            !this._isOwnUi(el) &&
            !el.disabled &&
            el.getAttribute('data-disabled') !== 'true' &&
            el.getAttribute('aria-disabled') !== 'true'
          );
          if (btn) return btn;
        }
      }
      return null;
    },

    insertText(text, mode = 'append') {
      const editor = this.getEditor();
      if (!editor) return false;
      try {
        if (editor.type === 'textarea') {
          const el = editor.el;
          const nextValue = mode === 'replace' ? text : el.value + text;
          this._setTextareaValue(el, nextValue, text, 'insertText');
          return true;
        }
        // contenteditable
        const el = editor.el;
        el.focus();
        if (mode === 'replace') {
          el.textContent = '';
        }
        // 使用 execCommand 插入文本（保留 undo 历史）
        document.execCommand('insertText', false, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      } catch (e) {
        console.log('[无水印] insertText error:', e);
        return false;
      }
    },

    clearInput() {
      const editor = this.getEditor();
      if (!editor) return false;
      try {
        if (editor.type === 'textarea') {
          this._setTextareaValue(editor.el, '', null, 'deleteContentBackward');
          return true;
        }
        editor.el.textContent = '';
        editor.el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      } catch (e) { return false; }
    },
  };

  function readArgsFromEditor() {
    const text = SiteAdapter.getInputText().trim();
    if (!text) return null;
    const unwrapped = unwrapInput(text);
    if (unwrapped.error) return null;
    return { tokens: splitEscaped(unwrapped.raw) };
  }

  // ── 脚本架构概述 ──────────────────────────────────────────────────────────
  // 1. ZIP 打包器：纯同步实现，不依赖 JSZip（豆包页面 polyfill 会卡死 JSZip）
  // 2. API 拦截：XHR 拦截 /im/chain/single（历史消息），Fetch 拦截 /chat/completion（实时生成）
  // 3. React Fiber 遍历：从 img/canvas 元素的 Fiber 树中提取 previewImage + downloadImage URL 对
  // 4. 图片合并去水印：previewImage（左上水印）+ downloadImage（右下水印）拼合为无水印图片
  //    支持重叠去水印和 API 直链两种模式，直链不可用时自动回退
  // 5. 收集系统：DOM 扫描 + API 拦截双通道采集，occurrence-aware 去重，上限 200 条
  // 6. 会话隔离：URL 变化自动清空缓存，RouterData 轻量签名检测变更
  // 7. UI：悬浮按钮 + 管理面板（图片网格、模式切换、批量下载、定位跳转）
  //    选择状态和批量下载进度持久化，事件委托，筛选口径一致

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
  const PageXMLHttpRequest = pageWindow.XMLHttpRequest || XMLHttpRequest;
  const originalXHROpen = PageXMLHttpRequest.prototype.open;
  const originalXHRSend = PageXMLHttpRequest.prototype.send;

  function getRequestUrl(input) {
    if (!input) return "";
    if (typeof input === "string") return input;
    if (typeof input.url === "string") return input.url;
    try { return String(input); } catch (_) { return ""; }
  }

  PageXMLHttpRequest.prototype.open = function (method, url, ...args) {
    this._nomark_url = getRequestUrl(url);
    return originalXHROpen.apply(this, [method, url, ...args]);
  };

  PageXMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const url = this._nomark_url || "";
        if (isMessageApiUrl(url)) extractImagesFromApiResponse(JSON.parse(this.responseText));
      } catch (err) {
        warnThrottled("xhr-parse", `XHR 响应解析失败: ${err.message}`);
      }
    });
    return originalXHRSend.apply(this, args);
  };

  const originalFetch = pageWindow.fetch;
  pageWindow.fetch = async function (...args) {
    const url = getRequestUrl(args[0]);
    const response = await originalFetch.apply(this, args);

    // 异步读取 clone，不阻塞页面接收原始 response
    if (url.includes("/chat/completion")) {
      readStreamForImages(response.clone());
    }
    if (isMessageApiUrl(url)) {
      readJsonResponseForImages(response.clone());
    }

    return response;
  };

  function isMessageApiUrl(url) {
    return url.includes("/im/chain/single") || url.includes("/im/chain/recent_conv");
  }

  function extractImagesFromApiResponse(data) {
    // pull_singe_chain_downlink_body 是豆包 API 的原始字段名（singe 疑为 single 的拼写错误）
    const singleMessages = data?.downlink_body?.pull_singe_chain_downlink_body?.messages;
    if (Array.isArray(singleMessages)) extractImagesFromMessages(singleMessages);

    // 画布侧栏打开时会调用 recent_conv 分页加载历史消息
    const recentBody = data?.downlink_body?.pull_recent_conv_chain_downlink_body;
    if (Array.isArray(recentBody?.messages)) extractImagesFromMessages(recentBody.messages);
  }

  async function readJsonResponseForImages(response) {
    try {
      extractImagesFromApiResponse(await response.json());
    } catch (err) {
      warnThrottled("json-resp", `API JSON 响应解析失败: ${err.message}`);
    }
  }

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
    } catch (err) {
      warnThrottled("stream-read", `流式响应读取失败: ${err.message}`);
    }
  }

  function extractImagesFromMessages(messages) {
    for (const msg of messages) {
      extractImagesFromMessage(msg);
    }
  }

  function extractImagesFromStreamChunk(json) {
    let creations = [];
    let streamMsgId = "";
    let streamConversationId = getConversationId();
    let streamCreateTime = Math.floor(Date.now() / 1000);
    let touchedImages = false;

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
        streamConversationId = eventData?.conversation_id || eventData?.message?.conversation_id || streamConversationId;
        const eventCreateTime = Number(eventData?.create_time || eventData?.message?.create_time) || 0;
        if (eventCreateTime) streamCreateTime = eventCreateTime;
        const content = eventData?.message?.content;
        if (content) {
          const parsed = typeof content === "string" ? JSON.parse(content) : content;
          if (Array.isArray(parsed.data)) {
            for (const item of parsed.data) {
              if (item.image_ori || item.image_thumb) {
                touchedImages = addCollectedImageFromApi(item, streamMsgId, null, undefined, streamCreateTime, streamConversationId) || touchedImages;
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
      if (creation.image) {
        touchedImages = addCollectedImageFromApi(creation.image, streamMsgId, null, undefined, streamCreateTime, streamConversationId) || touchedImages;
      }
    }
    if (touchedImages) scheduleCurrentRouteDataFetch(1800);
  }

  function addCollectedImageFromApi(imageObj, messageId, directUrl, source, createTime, conversationId) {
    const info = normalizeImageInfo(imageObj);
    if (!info) return false;
    const rawUrl = directUrl || extractDirectUrl(imageObj);
    return addCollectedImage(info, null, messageId, rawUrl, source, createTime, conversationId);
  }

  function isDirectDownloadUrl(url) {
    return isFetchableImageUrl(url) && !/watermark/i.test(url);
  }

  function getDirectCandidateUrl(candidate) {
    if (typeof candidate === "string" && isDirectDownloadUrl(candidate)) return candidate;
    if (candidate?.url && isDirectDownloadUrl(candidate.url)) return candidate.url;
    return null;
  }

  function extractDirectUrl(obj) {
    if (!obj || obj.noDirectDownload) return null;
    // 只有无水印原图字段或明确不带 watermark 后缀的 URL 才能作为 API 直链。
    const candidates = [obj.image_thumb_ori, obj.image_ori_raw, obj.image_raw, obj.originalImage];
    for (const c of candidates) {
      const url = getDirectCandidateUrl(c);
      if (url) return url;
    }
    return null;
  }

  function collectImageUrls(value, urls = []) {
    if (!value) return urls;
    if (typeof value === "string") {
      urls.push(value);
      return urls;
    }
    if (!isObject(value)) return urls;
    if (typeof value.url === "string") urls.push(value.url);
    if (typeof value.key === "string") urls.push(value.key);
    for (const key of [
      "image_ori", "image_thumb", "image_preview", "image_raw", "image_thumb_ori",
      "previewImage", "downloadImage", "thumbImage", "originalImage",
    ]) {
      collectImageUrls(value[key], urls);
    }
    return urls;
  }

  // 根据图片 URL 判断实际来源（rc_gen_image = AI 生成）
  function detectImageSource(imageObj, fallbackSource) {
    const urls = [
      imageObj?.image_ori?.url,
      imageObj?.image_thumb?.url,
      imageObj?.image_preview?.url,
      imageObj?.image_raw?.url,
      typeof imageObj?.image_ori === "string" ? imageObj.image_ori : null,
      ...collectImageUrls(imageObj),
    ].filter(Boolean);
    if (urls.some(url => url.includes("rc_gen_image"))) return "ai";
    return fallbackSource;
  }

  function extractImagesFromMessage(msg) {
    if (!isConversationIdCurrent(getMessageConversationId(msg))) return;
    const msgId = msg?.message_id || "";
    const conversationId = getMessageConversationId(msg) || getConversationId();
    const createTime = Number(msg?.create_time) || 0;
    const fallbackSource = msg?.user_type === 1 ? "user" : "ai";

    for (const block of (msg?.content_block || [])) {
      const creations = block?.content?.creation_block?.creations;
      if (!Array.isArray(creations)) continue;
      for (const creation of creations) {
        if (creation.image) {
          const src = detectImageSource(creation.image, fallbackSource);
          addCollectedImageFromApi(creation.image, msgId, null, src, createTime, conversationId);
        }
      }
    }

    // 来源 1: creation_full_content（AI 生成图片）
    const creationContent = msg?.ext?.creation_full_content;
    if (creationContent && typeof creationContent === "string") {
      try {
        const parsed = JSON.parse(creationContent);
        if (Array.isArray(parsed)) {
          for (const block of parsed) {
            const content = block?.BlockInfo?.BlockContent?.content;
            if (!content?.creation_block?.creations) continue;
            for (const creation of content.creation_block.creations) {
              if (creation.image) addCollectedImageFromApi(creation.image, msgId, null, "ai", createTime, conversationId);
            }
          }
        }
      } catch (_) {}
    }

    // 来源 2: content.image_list（用户上传/生成图片）
    if (msg?.content) {
      try {
        const content = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
        if (Array.isArray(content?.image_list)) {
          for (const img of content.image_list) {
            const src = detectImageSource(img, fallbackSource);
            addCollectedImageFromApi(img, msgId, null, src, createTime, conversationId);
          }
        }
      } catch (_) {}
    }

    // samantha_context.query_context.edit_image_url 是二次编辑的输入源图，不是本次输出图。
    // 输出图会出现在 content.image_list 或 creation_block 中，不能把输入源图挂到当前消息下。

    // 来源 3: content_block[].content.attachment_block.attachments[].image（用户上传图片）
    if (msg?.content_block) {
      try {
        for (const block of msg.content_block) {
          const attachments = block?.content?.attachment_block?.attachments;
          if (!Array.isArray(attachments)) continue;
          for (const att of attachments) {
            if (att?.image) {
              const src = detectImageSource(att.image, fallbackSource);
              addCollectedImageFromApi(att.image, msgId, null, src, createTime, conversationId);
            }
          }
        }
      } catch (_) {}
    }
  }

  // 从 _ROUTER_DATA 提取所有图片（画布侧栏全量加载时可用）
  // 从 URL 提取当前会话 ID（用于检测会话切换）
  function getConversationId() {
    const match = location.href.match(/\/chat\/(\d+)/);
    return match ? match[1] : "";
  }

  function getMessageConversationId(msg) {
    return String(msg?.conversation_id || "");
  }

  function isConversationIdCurrent(conversationId) {
    const currentId = getConversationId();
    return !currentId || !conversationId || String(conversationId) === currentId;
  }

  function getMessagesConversationId(messages) {
    const msg = messages.find(item => item?.conversation_id);
    return getMessageConversationId(msg);
  }

  function findRouterMessageList(value, seen = new WeakSet(), depth = 0) {
    if (!isObject(value) || seen.has(value) || depth > 8) return null;
    seen.add(value);

    const directMessages = value?.["chat_(id)/page"]?.messageList?.message_list;
    if (Array.isArray(directMessages)) return directMessages;

    const messageList = value?.messageList?.message_list;
    if (Array.isArray(messageList)) return messageList;

    if (Array.isArray(value?.message_list) && value.message_list.some(item => item?.message_id)) {
      return value.message_list;
    }

    for (const child of Object.values(value)) {
      const found = findRouterMessageList(child, seen, depth + 1);
      if (found) return found;
    }
    return null;
  }

  let lastConversationId = getConversationId();
  let shouldResetScannedElementsWhenRouterReady = false;
  let routeDataFetchTimer = null;

  function checkConversationChange() {
    const currentId = getConversationId();
    if (currentId && currentId !== lastConversationId) {
      lastConversationId = currentId;
      collectedImages.length = 0;
      collectedImagesMap.clear();
      resetTransientUiState();
      shouldResetScannedElementsWhenRouterReady = true;
      lastRouterSignature = "";
      updateModalCount();
      scheduleModalRenderIfOpen(true);
      scheduleCurrentRouteDataFetch();
      console.log("[无水印] 检测到会话切换，已清空图片缓存");
    }
  }

  function getRouterDataSignature(routerData) {
    if (!routerData) return "";
    try {
      const messages = findRouterMessageList(routerData.loaderData || routerData);
      if (!Array.isArray(messages) || messages.length === 0) return "empty";
      const last = messages[messages.length - 1];
      return `${messages.length}:${last?.message_id || ""}:${last?.create_time || ""}`;
    } catch (_) {
      return "error";
    }
  }

  function extractImagesFromRouterData(routerData = pageWindow._ROUTER_DATA) {
    try {
      checkConversationChange();
      if (!routerData) return false;
      const messages = findRouterMessageList(routerData.loaderData || routerData);
      if (!Array.isArray(messages) || messages.length === 0) return false;
      if (!isConversationIdCurrent(getMessagesConversationId(messages))) return false;

      if (shouldResetScannedElementsWhenRouterReady) {
        scannedElements = new WeakSet();
        shouldResetScannedElementsWhenRouterReady = false;
      }
      extractImagesFromMessages(messages);
      return true;
    } catch (err) {
      warnThrottled("router-extract", `RouterData 图片提取失败: ${err.message}`);
      return false;
    }
  }

  function parseRouterDataFromHtml(html) {
    const marker = "window._ROUTER_DATA = ";
    const start = html.indexOf(marker);
    if (start < 0) return null;
    let jsonText = html.slice(start + marker.length);
    const end = jsonText.indexOf("</script>");
    if (end >= 0) jsonText = jsonText.slice(0, end);
    jsonText = jsonText.trim().replace(/;$/, "");
    return JSON.parse(jsonText);
  }

  function scheduleCurrentRouteDataFetch(delay = 300) {
    if (routeDataFetchTimer) clearTimeout(routeDataFetchTimer);
    routeDataFetchTimer = setTimeout(fetchCurrentRouteData, delay);
  }

  async function fetchCurrentRouteData() {
    routeDataFetchTimer = null;
    const conversationId = getConversationId();
    if (!conversationId) return;
    try {
      const response = await pageWindow.fetch(location.href, { credentials: "include" });
      if (!response.ok) return;
      const html = await response.text();
      if (!isConversationIdCurrent(conversationId)) return;
      const routerData = parseRouterDataFromHtml(html);
      if (routerData) extractImagesFromRouterData(routerData);
    } catch (err) {
      console.warn("[无水印] 拉取当前会话 RouterData 失败", err);
    }
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

  const _warnTimers = {};
  function warnThrottled(key, msg, ms = 30000) {
    if (_warnTimers[key]) return;
    _warnTimers[key] = true;
    console.warn("[无水印]", msg);
    setTimeout(() => { _warnTimers[key] = false; }, ms);
  }

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

    return best ? { info: best.info, raw: best.raw } : null;
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

  function uniqueElements(elements) {
    return elements.filter((el, index) => el && elements.indexOf(el) === index);
  }

  function getPointMediaElements(e) {
    if (!Number.isFinite(e?.clientX) || !Number.isFinite(e?.clientY)) return [];

    const elementsAtPoint = typeof document.elementsFromPoint === "function"
      ? document.elementsFromPoint(e.clientX, e.clientY)
      : [];
    const pointMedia = elementsAtPoint
      .filter(node => isElement(node))
      .flatMap(el => {
        const media = [];
        if (el.matches?.("img,canvas")) media.push(el);
        const closestMedia = el.closest?.("img,canvas");
        if (closestMedia && closestMedia !== el) media.push(closestMedia);
        return media;
      });

    const rectMedia = [...document.querySelectorAll("canvas,img")].filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width >= MIN_ELEMENT_SIZE
        && rect.height >= MIN_ELEMENT_SIZE
        && e.clientX >= rect.left
        && e.clientX <= rect.right
        && e.clientY >= rect.top
        && e.clientY <= rect.bottom;
    });

    return uniqueElements([...pointMedia, ...rectMedia]);
  }

  function getImageInfoFromPoint(e) {
    const elements = getPointMediaElements(e);
    const targetUrl = elements
      .map(el => el.currentSrc || el.src || "")
      .find(Boolean) || "";

    for (const el of elements) {
      const info = getImageInfoFromElement(el, targetUrl);
      if (info) return info;
    }

    return null;
  }

  function getImageInfoFromEvent(e) {
    const path = getEventPath(e).filter(node => isElement(node));
    const elements = uniqueElements([...path, ...getPointMediaElements(e)]);
    const targetUrl = elements
      .map(el => el.currentSrc || el.src || "")
      .find(Boolean) || "";

    for (const el of elements) {
      const info = getImageInfoFromElement(el, targetUrl);
      if (info) return info;
    }

    return null;
  }

  function hasImageContextTarget(e) {
    return !!e.target.closest?.("img,canvas") || getPointMediaElements(e).length > 0;
  }

  function getBestVisibleImageInfo() {
    const rectCache = new Map();
    const getRect = (el) => {
      if (!rectCache.has(el)) rectCache.set(el, el.getBoundingClientRect());
      return rectCache.get(el);
    };
    const elements = [...document.querySelectorAll("canvas,img")]
      .filter(el => {
        const rect = getRect(el);
        return rect.width >= MIN_ELEMENT_SIZE && rect.height >= MIN_ELEMENT_SIZE && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      })
      .sort((a, b) => {
        const ra = getRect(a);
        const rb = getRect(b);
        const canvasBias = (b.tagName === "CANVAS" ? 1e8 : 0) - (a.tagName === "CANVAS" ? 1e8 : 0);
        return canvasBias || (rb.width * rb.height - ra.width * ra.height);
      });

    for (const el of elements) {
      const result = getImageInfoFromElement(el, el.currentSrc || el.src || "");
      if (result?.info) return result.info;
    }
    return null;
  }

  // ── 图片收集系统 ─────────────────────────────────────────────────────────
  const collectedImages = [];
  const collectedImagesMap = new Map(); // key → index, O(1) 去重
  const MAX_COLLECTED_IMAGES = 200;     // 容量上限，防内存泄漏
  const selectedIndices = new Set();    // 持久化选择状态
  let batchProgress = createEmptyBatchProgress(); // 批量下载进度
  var modalRenderTimer = null;
  var collectionSeq = 0;

  function createEmptyBatchProgress() {
    return {
      status: "",
      selectedIndices: null,
      total: 0,
      currentNum: 0,
      currentIndex: -1,
      successCount: 0,
      doneIndices: null,
      isDirect: false,
    };
  }

  function resetTransientUiState() {
    selectedIndices.clear();
    batchProgress = createEmptyBatchProgress();
  }

  function scheduleModalRenderIfOpen(immediate = false) {
    if (!document.querySelector("#doubao-nomark-modal.show")) return;
    if (immediate) {
      if (modalRenderTimer) {
        clearTimeout(modalRenderTimer);
        modalRenderTimer = null;
      }
      renderModalImages();
      return;
    }
    if (modalRenderTimer) clearTimeout(modalRenderTimer);
    modalRenderTimer = setTimeout(() => {
      modalRenderTimer = null;
      renderModalImages();
    }, 100);
  }

  // 调试接口：暴露到页面上下文
  const debugTarget = pageWindow;
  debugTarget._nomarkDebug = {
    getCollectedImages: () => collectedImages.map(item => ({
      conversationId: item.conversationId,
      source: item.source,
      createTime: item.createTime,
      messageId: item.messageId,
      messageImageIndex: item.messageImageIndex,
      sequence: item.sequence,
      hasElement: !!item.element,
      hasDirectUrl: !!item.directUrl,
      thumbnailUrl: item.thumbnailUrl?.substring(0, 50)
    })),
    getImageFilter: () => imageFilter,
    getCollectedCount: () => getCurrentCollectedImages().length,
    getSourceDistribution: () => getCurrentCollectedImages().reduce((acc, item) => {
      acc[item.source] = (acc[item.source] || 0) + 1;
      return acc;
    }, {}),
    getCreateTimeCount: () => getCurrentCollectedImages().filter(item => item.createTime > 0).length
  };

  function getCurrentCollectedImages() {
    const conversationId = getConversationId();
    return collectedImages.filter(item => !conversationId || item.conversationId === conversationId);
  }

  function isCurrentConversationItem(item) {
    const conversationId = getConversationId();
    return Boolean(item && (!conversationId || item.conversationId === conversationId));
  }

  function isCurrentDisplayItem(item) {
    return isCurrentConversationItem(item) && (imageFilter === "all" || item.source === imageFilter);
  }

  function getSelectedDisplayIndices() {
    return [...selectedIndices].filter(idx => isCurrentDisplayItem(collectedImages[idx]));
  }

  function getImageKeyForDedup(info) {
    return info?.key || extractImageKey(info?.previewImage?.url) || extractImageKey(info?.downloadImage?.url) || "";
  }

  function getCollectedImageMapKey(conversationId, imageKey) {
    return `${conversationId || "unknown"}::${imageKey}`;
  }

  function addCollectedImage(info, element, messageId, directUrl, source, createTime, conversationId = getConversationId()) {
    if (!info?.previewImage?.url || !info?.downloadImage?.url) return false;
    if (!isConversationIdCurrent(conversationId)) return false;
    const recordConversationId = conversationId || getConversationId() || "unknown";
    const key = getImageKeyForDedup(info);
    if (!key) return false;
    console.log(`[无水印] 添加图片: source=${source}, createTime=${createTime}, key=${key.substring(0, 30)}`);
    const mapKey = getCollectedImageMapKey(recordConversationId, key);
    const existingIdx = collectedImagesMap.get(mapKey);
    if (existingIdx !== undefined) {
      const existing = collectedImages[existingIdx];
      let changed = false;
      const isEarlierOccurrence = createTime && (!existing.createTime || createTime < existing.createTime);
      const isSamePrimaryOccurrence = createTime && existing.createTime === createTime && (!existing.messageId || !messageId || existing.messageId === messageId);
      const shouldUpdatePrimaryOccurrence = isEarlierOccurrence || isSamePrimaryOccurrence;
      if (shouldUpdatePrimaryOccurrence) {
        if (existing.info !== info) { existing.info = info; changed = true; }
        if (existing.thumbnailUrl !== info.previewImage.url) { existing.thumbnailUrl = info.previewImage.url; changed = true; }
      }
      if (element && (!existing.element || shouldUpdatePrimaryOccurrence)) { existing.element = element; changed = true; }
      if (messageId && (!existing.messageId || shouldUpdatePrimaryOccurrence)) {
        if (existing.messageId !== messageId) changed = true;
        existing.messageId = messageId;
      }
      if (messageId && (existing.messageImageIndex == null || shouldUpdatePrimaryOccurrence)) {
        const nextMessageImageIndex = collectedImages.filter(item =>
          item !== existing
          && item.conversationId === recordConversationId
          && item.messageId === messageId
        ).length;
        if (existing.messageImageIndex !== nextMessageImageIndex) changed = true;
        existing.messageImageIndex = nextMessageImageIndex;
      }
      if (directUrl && !existing.directUrl) { existing.directUrl = directUrl; changed = true; }
      if (source && (!existing.source || shouldUpdatePrimaryOccurrence || (!existing.createTime && source !== "ai"))) {
        if (existing.source !== source) changed = true;
        existing.source = source;
      }
      if (createTime && (!existing.createTime || isEarlierOccurrence)) { existing.createTime = createTime; changed = true; }
      if (changed) {
        updateModalCount();
        scheduleModalRenderIfOpen();
      }
      return false;
    }
    if (collectedImages.length >= MAX_COLLECTED_IMAGES) return false;
    const messageImageIndex = messageId
      ? collectedImages.filter(item => item.conversationId === recordConversationId && item.messageId === messageId).length
      : null;
    collectedImagesMap.set(mapKey, collectedImages.length);
    collectedImages.push({
      info, thumbnailUrl: info.previewImage.url,
      element: element || null, messageId: messageId || null, directUrl: directUrl || null,
      source: source || "ai", createTime: createTime || 0, messageImageIndex,
      conversationId: recordConversationId,
      sequence: collectionSeq++
    });
    updateModalCount();
    scheduleModalRenderIfOpen();
    return true;
  }

  let scannedElements = new WeakSet(); // 跳过已处理元素，避免重复 Fiber 遍历

  // 触发画布侧栏（优先 canvas，回退最大 img，带重试）
  async function triggerCanvasSidebar() {
    const scroller = document.querySelector(".v_list_scroller-BxcoIX");
    if (!scroller) return false;

    for (let retry = 0; retry < 3; retry++) {
      // 优先找 canvas（大图渲染）
      let target = scroller.querySelector("canvas");
      // 回退找可视区域内最大的 byteimg img
      if (!target) {
        const imgs = [...scroller.querySelectorAll("img[src*='byteimg.com']")];
        target = imgs
          .filter(el => el.getBoundingClientRect().width > 100)
          .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
      }
      if (target) {
        target.click();
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  // 关闭画布侧栏
  async function closeCanvasSidebar() {
    // 派发 Escape 到 document（经测试此方式可关闭侧栏）
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
    return true;
  }

  // 全量扫描：自动滚动对话触发懒加载
  async function fullScanConversation() {
    const scroller = document.querySelector(".v_list_scroller-BxcoIX")
      || document.querySelector("[class*='v_list_scroller']")
      || document.querySelector(".scroller");
    if (!scroller) throw new Error("未找到聊天滚动容器");

    // 先关闭模态框避免遮挡
    closeModal();
    await new Promise(r => setTimeout(r, 200));

    // 记录当前视口中的消息 ID 和滚动位置用于恢复
    const originalTop = scroller.scrollTop;
    const anchorMessageId = findVisibleMessageId();

    // 步骤 1：触发画布侧栏加载 _ROUTER_DATA（保持打开）
    showToast("正在加载图片数据…", 0);
    const sidebarOpened = await triggerCanvasSidebar();
    if (sidebarOpened) {
      await new Promise(r => setTimeout(r, 1500));
      extractImagesFromRouterData();
    }

    // 步骤 2：滚动扫描（侧栏保持打开）
    const scrollHeight = scroller.scrollHeight;
    const clientHeight = scroller.clientHeight;
    const step = Math.max(clientHeight * 0.8, 200);
    const totalSteps = Math.ceil(scrollHeight / step);

    scroller.scrollTop = 0;
    await new Promise(r => setTimeout(r, 300));

    for (let i = 0; i <= totalSteps; i++) {
      scroller.scrollTop = i * step;
      await new Promise(r => setTimeout(r, 350));
      scanAndCollectImages();
      extractImagesFromRouterData();
      showToast(`扫描中 ${i + 1}/${totalSteps + 1}，已发现 ${getCurrentCollectedImages().length} 张图片`, 0);
    }

    scroller.scrollTop = scrollHeight;
    await new Promise(r => setTimeout(r, 400));
    scanAndCollectImages();
    extractImagesFromRouterData();

    // 步骤 3：扫描完成，关闭侧栏，恢复位置
    await closeCanvasSidebar();
    await new Promise(r => setTimeout(r, 300));
    // 重新查询 scroller（React 可能已重新渲染）
    const freshScroller = document.querySelector(".v_list_scroller-BxcoIX")
      || document.querySelector("[class*='v_list_scroller']")
      || document.querySelector(".scroller")
      || scroller;
    // 优先通过消息 ID 定位，回退到滚动位置
    if (anchorMessageId && scrollToMessage(anchorMessageId)) {
      // 通过消息 ID 定位成功
    } else {
      freshScroller.scrollTop = originalTop;
    }
  }

  // 查找当前视口中最接近中心的消息 ID
  function findVisibleMessageId() {
    const rows = document.querySelectorAll("[data-observe-row]");
    const centerY = window.innerHeight / 2;
    let closest = null;
    let closestDist = Infinity;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      const dist = Math.abs(rect.top + rect.height / 2 - centerY);
      if (dist < closestDist) {
        closestDist = dist;
        closest = row;
      }
    }
    const rowId = closest?.dataset?.observeRow || "";
    return rowId.startsWith("block_") ? rowId.replace("block_", "") : null;
  }

  function scanAndCollectImages() {
    const elements = [...document.querySelectorAll("canvas,img")]
      .filter(el => {
        if (scannedElements.has(el)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= MIN_ELEMENT_SIZE && rect.height >= MIN_ELEMENT_SIZE;
      });

    for (const el of elements) {
      scannedElements.add(el);
      const result = getImageInfoFromElement(el, el.currentSrc || el.src || "");
      if (result?.info) {
        const directUrl = result.raw ? extractDirectUrl(result.raw) : null;
        addCollectedImage(result.info, el, getMessageIdFromElement(el), directUrl, detectImageSource(result.info, "user"));
      }
    }
  }

  function getChatScroller() {
    return document.querySelector(".v_list_scroller-BxcoIX")
      || document.querySelector("[class*='v_list_scroller']")
      || document.querySelector(".scroller");
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

  function getImageMatchHints(info) {
    return [
      info?.previewImage?.url,
      info?.downloadImage?.url,
      info?.thumbImage?.url,
      info?.originalImage?.url,
      info?.key,
    ].filter(Boolean);
  }

  function isVisibleChatMediaElement(el) {
    if (!el?.isConnected) return false;
    if (el.closest("#doubao-nomark-modal")) return false;
    if (!el.closest("[data-observe-row]")) return false;
    const rect = el.getBoundingClientRect();
    const src = el.currentSrc || el.src || "";
    return rect.width >= MIN_ELEMENT_SIZE
      && rect.height >= MIN_ELEMENT_SIZE
      && (el.tagName === "CANVAS" || (src && !src.startsWith("data:image/svg")));
  }

  function sameVisibleChatImage(a, b) {
    if (sameImageKey(a, b)) return true;
    const nameA = extractImageKey(a).split("/").pop();
    const nameB = extractImageKey(b).split("/").pop();
    return Boolean(
      nameA
      && nameA === nameB
      && /^[a-f0-9]{32}\.(?:jpe?g|png|webp)$/i.test(nameA)
    );
  }

  function findVisibleChatElementByInfo(targetInfo) {
    if (!targetInfo) return null;
    const targetKey = getImageKeyForDedup(targetInfo);
    if (!targetKey) return null;
    const targetHints = getImageMatchHints(targetInfo);
    const targetValues = [...targetHints, targetKey].filter(Boolean);
    const elements = document.querySelectorAll("[data-observe-row] canvas,[data-observe-row] img");
    for (const el of elements) {
      if (!isVisibleChatMediaElement(el)) continue;
      const elementUrl = el.currentSrc || el.src || "";
      const matchedUrl = elementUrl && targetValues.some(url => sameVisibleChatImage(url, elementUrl));
      if (elementUrl && !matchedUrl) continue;
      const targetUrl = targetValues.find(url => sameVisibleChatImage(url, elementUrl)) || elementUrl || targetHints[0];
      const info = getImageInfoFromElement(el, targetUrl);
      if (info && sameVisibleChatImage(getImageKeyForDedup(info), targetKey)) return el;
      if (matchedUrl) return el;
    }
    return null;
  }

  // 通过图片信息在当前 DOM 中查找匹配的元素
  function findElementByInfo(targetInfo, messageId) {
    if (!targetInfo) return null;
    const targetKey = getImageKeyForDedup(targetInfo);
    if (!targetKey) return null;
    const row = messageId ? document.querySelector(`[data-observe-row="block_${messageId}"]`) : null;
    if (messageId && !row) return null;
    const searchRoot = row || document;
    const targetHints = getImageMatchHints(targetInfo);
    const elements = searchRoot.querySelectorAll("canvas,img");
    for (const el of elements) {
      const elementUrl = el.currentSrc || el.src || "";
      if (row && elementUrl && !targetHints.some(url => sameImageKey(url, elementUrl))) continue;
      const targetUrl = targetHints.find(url => sameImageKey(url, elementUrl)) || targetHints[0] || elementUrl;
      const info = getImageInfoFromElement(el, targetUrl);
      if (info && getImageKeyForDedup(info) === targetKey) return el;
    }
    return null;
  }

  function findElementByMessageIndex(messageId, imageIndex) {
    if (!messageId || imageIndex == null) return null;
    const row = document.querySelector(`[data-observe-row="block_${messageId}"]`);
    if (!row) return null;
    const elements = [...row.querySelectorAll("canvas,img")].filter(el => {
      const rect = el.getBoundingClientRect();
      const src = el.currentSrc || el.src || "";
      return rect.width >= MIN_ELEMENT_SIZE
        && rect.height >= MIN_ELEMENT_SIZE
        && (el.tagName === "CANVAS" || (src && !src.startsWith("data:image/svg")));
    });
    return elements[imageIndex] || null;
  }

  function isElementUsableForItem(el, item) {
    if (!el?.isConnected || !item) return false;
    if (!item.messageId) return true;
    return getMessageIdFromElement(el) === item.messageId;
  }

  // 通过虚拟列表内部 positionMap 精确滚动到指定消息
  // 注意：依赖豆包虚拟列表组件的内部实现（positionMap._sections），
  // 若豆包前端升级依赖版本此功能可能静默失效，不影响核心下载功能。
  function scrollToMessage(messageId) {
    if (!messageId) return false;
    const visibleRow = document.querySelector(`[data-observe-row="block_${messageId}"]`);
    if (visibleRow) {
      visibleRow.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    }

    const scroller = getChatScroller();
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
  let lastRouterSignature = "";

  function checkUrlChange() {
    if (location.href !== lastScanUrl) {
      lastScanUrl = location.href;
      collectedImages.length = 0;
      collectedImagesMap.clear();
      resetTransientUiState();
      shouldResetScannedElementsWhenRouterReady = true;
      lastRouterSignature = "";
      updateModalCount();
      scheduleModalRenderIfOpen(true);
      scheduleCurrentRouteDataFetch();
      console.log("[无水印] 检测到页面切换，已清空图片缓存");
    }
  }

  // 立即检测 URL 变化（SPA 导航），不等 3 秒轮询
  window.addEventListener("popstate", checkUrlChange);
  const origPushState = history.pushState;
  history.pushState = function (...args) {
    origPushState.apply(this, args);
    checkUrlChange();
  };
  const origReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    origReplaceState.apply(this, args);
    checkUrlChange();
  };

  function startScanning() {
    if (scanTimer) return;
    // 首次加载时从 _ROUTER_DATA 提取全量图片
    extractImagesFromRouterData();
    scanTimer = setInterval(() => {
      checkUrlChange();
      checkConversationChange();
      scanAndCollectImages();
      // 监听 _ROUTER_DATA 变化（画布侧栏打开时会填充数据）
      try {
        const sig = getRouterDataSignature(pageWindow._ROUTER_DATA);
        if (sig !== lastRouterSignature) {
          if (extractImagesFromRouterData()) {
            lastRouterSignature = sig;
          }
        }
      } catch (err) {
        warnThrottled("router-poll", `RouterData 轮询检测异常: ${err.message}`);
      }
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
    border: 1px solid #ff6060; border-radius: 10px; z-index: 2147483647;
    font-family: sans-serif; box-shadow: 0 2px 10px rgba(0,0,0,0.2);
    transition: opacity 0.3s ease; display: none; text-align: center;
  `;
  if (document.body) {
    document.body.appendChild(toastDiv);
  } else {
    document.addEventListener("DOMContentLoaded", () => document.body.appendChild(toastDiv));
  }

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

  function showPromptDialog({ title, body, input, inputValue, confirmText, cancelText, danger }) {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "pm-modal-overlay";
      overlay.innerHTML = `
        <div class="pm-modal pm-dialog-modal">
          <h4>${escHtml(title)}</h4>
          ${body ? `<div class="pm-dialog-body">${body}</div>` : ""}
          ${input !== undefined ? `<input class="pm-dialog-input" type="text" value="${escAttr(inputValue || "")}" placeholder="${escAttr(input || "")}" />` : ""}
          <div class="pm-modal-btns">
            <button class="pm-btn-cancel" id="pm-dialog-cancel">${cancelText || "取消"}</button>
            <button class="${danger ? "pm-btn-danger" : "pm-btn-save"}" id="pm-dialog-confirm">${confirmText || "确认"}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const inputEl = overlay.querySelector(".pm-dialog-input");
      if (inputEl) setTimeout(() => inputEl.focus(), 50);

      let closed = false;
      const close = value => {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", onKeydown);
        overlay.remove();
        resolve(value);
      };
      const onKeydown = e => {
        if (e.key === "Enter") { e.preventDefault(); close(inputEl ? inputEl.value : true); }
        if (e.key === "Escape") { e.preventDefault(); close(null); }
      };
      document.addEventListener("keydown", onKeydown);
      overlay.querySelector("#pm-dialog-cancel").addEventListener("click", () => close(null));
      overlay.querySelector("#pm-dialog-confirm").addEventListener("click", () => close(inputEl ? inputEl.value : true));
      overlay.addEventListener("click", e => { if (e.target === overlay) close(null); });
    });
  }

  async function customConfirm(message, { danger } = {}) {
    return showPromptDialog({
      title: "确认操作",
      body: message.replace(/\n/g, "<br>"),
      confirmText: "确定",
      cancelText: "取消",
      danger,
    });
  }

  async function customPrompt(title, placeholder, defaultValue) {
    return showPromptDialog({
      title,
      input: placeholder,
      inputValue: defaultValue,
      confirmText: "确定",
      cancelText: "取消",
    });
  }

  let promptHelpDialogOpen = false;
  async function showPromptHelpDialog({ remember = false } = {}) {
    if (promptHelpDialogOpen) return;
    promptHelpDialogOpen = true;
    try {
      await showPromptDialog({
        title: "使用说明",
        body: `
          <div class="pm-help-dialog">
            <b>提示词库</b>用于管理、检索和快速填入提示词到豆包输入框。<br><br>
            <b>基本功能：</b><br>
            · 点击「填入」将提示词追加到输入框<br>
            · 点击「发送」将提示词填入并自动发送<br>
            · 点击「收藏」将提示词置顶<br>
            · 拖拽分类或卡片可调整顺序<br><br>
            <b>模板变量：</b><br>
            在提示词中用 <code>{变量名}</code> 定义占位符。<br>
            可设置默认值：<code>{变量名='默认值'}</code><br>
            输入框为空时自动使用默认值，有非引号内容时正常追加。<br><br>
            <b>传参格式：</b><br>
            输入框中用引号包裹参数，支持 <code>'</code> <code>"</code> <code>‘’</code> <code>“”</code>，开头结尾必须是同一种引号。<br>
            参数用 <code>|</code> 分隔。<br><br>
            <b>示例 1 — 顺序传参：</b><br>
            提示词：<code>画一幅{主体}在{场景}的{风格}画</code><br>
            输入框：<code>'猫|花园|水彩'</code><br>
            结果：<code>画一幅猫在花园的水彩画</code><br><br>
            <b>示例 2 — 命名传参：</b><br>
            输入框：<code>'主体=猫|风格=水彩'</code><br>
            结果：<code>画一幅猫在{场景}的水彩画</code><br><br>
            <b>示例 3 — 混用传参：</b><br>
            输入框：<code>'猫|场景=花园|水彩'</code><br>
            结果：<code>画一幅猫在花园的水彩画</code><br><br>
            <b>示例 4 — 跳过变量：</b><br>
            输入框：<code>'猫||水彩'</code><br>
            结果：<code>画一幅猫在{场景}的水彩画</code>（空位跳过）<br><br>
            <b>示例 5 — 默认值：</b><br>
            提示词：<code>画一幅{主体='猫'}在{场景}的{风格}画</code><br>
            输入框：（空）<br>
            结果：<code>画一幅猫在{场景}的{风格}画</code><br><br>
            <b>示例 6 — 空位触发默认值：</b><br>
            输入框：<code>'|花园|水彩'</code><br>
            结果：<code>画一幅猫在花园的水彩画</code><br><br>
            <b>转义：</b> <code>\\|</code> 竖线 · <code>\\\\</code> 反斜杠 · <code>\\n</code> 换行
          </div>
        `,
        confirmText: "知道了",
      });
      if (remember) await GM_setValue(PromptConfig.HELP_SEEN_KEY, true);
    } finally {
      promptHelpDialogOpen = false;
    }
  }

  // ── 右键时捕获 imageInfo ────────────────────────────────────────────────────
  let capturedImageInfo = null;
  let capturedAt = 0;
  let lastContextMenuHadImage = false;

  document.addEventListener("contextmenu", (e) => {
    if (!hasImageContextTarget(e)) {
      lastContextMenuHadImage = false;
      return;
    }

    lastContextMenuHadImage = true;
    const eventResult = getImageInfoFromEvent(e) || getImageInfoFromPoint(e);
    capturedImageInfo = eventResult?.info || eventResult || null;
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

  // ── 提示词库：LibraryUI 核心逻辑 ────────────────────────────────────────────
  const LibraryUI = {
    _prompts: [],
    _categories: [],
    _searchKeyword: '',
    _activeCategory: '全部',
    _editingId: null,
    _frequentOrder: [],
    _catOrder: [],
    _dragState: null,
    _catDragActive: false,
    _listDragActive: false,

    async init() {
      this._prompts = await StorageService.load();
      this._frequentOrder = await StorageService.loadFrequentOrder();
      this._catOrder = await StorageService.loadCategoryOrder();
      this._categories = await StorageService.loadCategories();
    },

    _getCategoryList() {
      const fromPrompts = new Set(this._prompts.map(p => p.category).filter(Boolean));
      return [...new Set([...this._categories, ...fromPrompts])];
    },

    async _addCategory(name) {
      name = name.trim();
      if (!name) return;
      if (this._categories.includes(name)) { showToast('该分类已存在'); return; }
      this._categories.push(name);
      await StorageService.saveCategories(this._categories);
      this.renderCategories();
    },

    async _deleteCategory(name) {
      const promptsInCat = this._prompts.filter(p => p.category === name);
      const count = promptsInCat.length;
      let msg;
      if (count > 0) {
        const titles = promptsInCat.slice(0, 5).map(p => `· ${escHtml(p.title)}`).join('<br>');
        const more = count > 5 ? `<br>...及其他 ${count - 5} 条` : '';
        msg = `确定删除分类「${escHtml(name)}」？<br><br>该分类下的 <b>${count}</b> 条提示词将一并删除：<br>${titles}${more}<br><br>此操作不可撤销。`;
      } else {
        msg = `确定删除分类「${escHtml(name)}」？`;
      }
      if (!await customConfirm(msg, { danger: true })) return;
      this._prompts = this._prompts.filter(p => p.category !== name);
      this._categories = this._categories.filter(c => c !== name);
      await StorageService.save(this._prompts);
      await StorageService.saveCategories(this._categories);
      if (this._activeCategory === name) this._activeCategory = '全部';
      this.renderCategories();
      this.renderList();
      showToast(`已删除分类「${name}」及 ${count} 条提示词`);
    },

    render() {
      this.renderCategories();
      this.renderList();
    },

    _getFrequentPrompts(limit = 10) {
      const now = Date.now();
      const scored = this._prompts
        .filter(p => p.usageCount > 0 && p.lastUsedAt)
        .map(p => {
          const daysSinceUse = (now - new Date(p.lastUsedAt).getTime()) / 86400000;
          const recencyScore = Math.max(0, 100 - daysSinceUse * 5);
          const usageScore = Math.min(p.usageCount * 10, 100);
          return { prompt: p, score: usageScore * 0.6 + recencyScore * 0.4 };
        })
        .sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map(s => s.prompt);
    },

    renderCategories() {
      if (this._catDragActive) return;
      // 清理可能残留的分类拖拽 ghost
      document.querySelectorAll('.pm-cat-lifted, .pm-cat-placeholder').forEach(el => el.remove());
      const container = document.getElementById('pm-categories');
      if (!container) return;
      const fixedCats = ['常用', '全部'];
      const allCats = this._getCategoryList();
      const orderedCats = [];
      for (const c of this._catOrder) {
        if (allCats.includes(c) && !fixedCats.includes(c)) orderedCats.push(c);
      }
      for (const c of allCats) {
        if (!fixedCats.includes(c) && !orderedCats.includes(c)) orderedCats.push(c);
      }
      const renderCat = (c, isDraggable) => {
        const isActive = c === this._activeCategory;
        const canDelete = !fixedCats.includes(c);
        return `<span class="pm-cat-btn${isActive ? ' pm-active' : ''}${isDraggable ? ' pm-cat-draggable' : ''}" data-cat="${c}"><span class="pm-cat-label">${escHtml(c)}${canDelete ? '<button class="pm-cat-del" data-cat="' + c + '" title="删除分类">×</button>' : ''}</span></span>`;
      };
      let html = fixedCats.map(c => renderCat(c, false)).join('');
      html += orderedCats.map(c => renderCat(c, true)).join('');
      html += '<button class="pm-cat-add" id="pm-cat-add" title="新增分类">+ </button>';
      container.innerHTML = html;
      container.querySelectorAll('[data-cat]').forEach(btn => {
        if (btn.classList.contains('pm-cat-del')) return;
        btn.addEventListener('click', e => {
          if (e.target.classList.contains('pm-cat-del')) return;
          this._activeCategory = btn.dataset.cat;
          this.renderCategories();
          this.renderList();
        });
      });
      container.querySelectorAll('.pm-cat-del').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); this._deleteCategory(btn.dataset.cat); });
      });
      document.getElementById('pm-cat-add')?.addEventListener('click', async () => {
        const name = await customPrompt('新增分类', '请输入分类名称');
        if (name) this._addCategory(name);
      });
      this._bindCatDragEvents(container);
    },

    renderList() {
      if (this._listDragActive) return;
      // 清理可能残留的列表拖拽 ghost
      document.querySelectorAll('.pm-lifted, .pm-drag-placeholder').forEach(el => el.remove());
      const container = document.getElementById('pm-list');
      if (!container) return;
      let filtered;
      if (this._activeCategory === '常用') {
        filtered = this._getFrequentPrompts(10);
        filtered = PromptService.search(this._searchKeyword, filtered);
        if (this._frequentOrder.length > 0) {
          const orderMap = new Map(this._frequentOrder.map((id, i) => [id, i]));
          filtered.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
        }
      } else {
        filtered = PromptService.filterByCategory(this._activeCategory, this._prompts);
        filtered = PromptService.search(this._searchKeyword, filtered);
        filtered.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      }
      if (filtered.length === 0) {
        container.innerHTML = `<div class="pm-empty">${this._prompts.length === 0 ? '还没有提示词，点击下方按钮添加' : '没有匹配的提示词'}</div>`;
        return;
      }
      const favs = filtered.filter(p => p.favorite);
      const normals = filtered.filter(p => !p.favorite);
      const renderItem = p => `
        <div class="pm-item" data-id="${p.id}">
          <div class="pm-item-inner">
            <div class="pm-item-title">
              ${p.favorite ? '<span class="pm-fav">★</span>' : ''}
              <span>${escHtml(p.title)}</span>
              <span class="pm-item-title-tags">${(p.tags || []).map(t => `<span class="pm-tag">${escHtml(t)}</span>`).join('')}</span>
            </div>
            <div class="pm-item-preview">${escHtml(p.content)}</div>
            <div class="pm-item-meta">
              ${(() => { const vars = parseTemplate(p.content); return vars.length > 0 ? `<div class="pm-item-tags">${vars.map(v => { const def = v.defaultVal; const label = def ? (def.length > 5 ? v.name + "='" + def.slice(0, 5) + "…'" : v.name + "='" + def + "'") : v.name; return `<span class="pm-tag pm-var-tag">{${escHtml(label)}}</span>`; }).join('')}</div>` : ''; })()}
              <div class="pm-item-actions">
                <button class="pm-btn-fill" data-id="${p.id}" title="追加到输入框"><span class="pm-btn-ico">⌨️</span><span class="pm-btn-label">只填</span></button>
                <button class="pm-btn-fill-send" data-id="${p.id}" title="填入并发送"><span class="pm-btn-ico">📨</span><span class="pm-btn-label">填发</span></button>
                <button class="pm-btn-fav" data-id="${p.id}" title="${p.favorite ? '取消收藏' : '收藏'}"><span class="pm-btn-ico">${p.favorite ? '⭐' : '☆'}</span><span class="pm-btn-label">收藏</span></button>
                <button class="pm-btn-edit" data-id="${p.id}" title="编辑"><span class="pm-btn-ico">✏️</span><span class="pm-btn-label">编辑</span></button>
                <button class="pm-btn-del" data-id="${p.id}" title="删除"><span class="pm-btn-ico">🗑️</span><span class="pm-btn-label">删除</span></button>
              </div>
            </div>
          </div>
        </div>`;
      const favHtml = favs.map(renderItem).join('');
      const dividerHtml = favs.length > 0 && normals.length > 0 ? '<div class="pm-fav-divider"><span>收藏</span></div>' : '';
      const normalHtml = normals.map(renderItem).join('');
      container.innerHTML = favHtml + dividerHtml + normalHtml;
      container.querySelectorAll('.pm-btn-fill').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._fillPrompt(btn.dataset.id); }));
      container.querySelectorAll('.pm-btn-fill-send').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._fillAndSendPrompt(btn.dataset.id); }));
      container.querySelectorAll('.pm-btn-edit').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this.showEditModal(btn.dataset.id); }));
      container.querySelectorAll('.pm-btn-del').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._deletePrompt(btn.dataset.id); }));
      container.querySelectorAll('.pm-btn-fav').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._toggleFavorite(btn.dataset.id); }));
      this._bindDragEvents(container);
    },

    _bindDragEvents(container) {
      if (container._pmDragCleanup) container._pmDragCleanup();
      const self = this;
      const MOVE_THRESHOLD = 6;
      let drag = null;
      let raf = 0;
      let lastClientY = 0;
      const clearFrame = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
      const getListItems = () => [...container.querySelectorAll('.pm-item:not(.pm-lifted):not(.pm-drag-source)')];
      const getDivider = () => container.querySelector('.pm-fav-divider');
      const setGhostTransform = (dx, dy, ghost = drag?.ghost) => {
        if (!ghost) return;
        ghost.style.setProperty('--pm-drag-x', `${dx}px`);
        ghost.style.setProperty('--pm-drag-y', `${dy}px`);
        ghost.style.setProperty('--pm-drag-rotate', `${Math.max(-0.95, Math.min(0.95, dx / 155))}deg`);
      };
      const applyJiggleDelays = () => { getListItems().forEach((el, i) => el.style.setProperty('--pm-jiggle-delay', `${-(i % 5) * 84}ms`)); };
      const animateLayoutShift = (mutate) => {
        const items = getListItems();
        const first = new Map(items.map(el => [el, el.getBoundingClientRect()]));
        mutate();
        const shifted = [];
        for (const el of items) {
          if (!el.isConnected) continue;
          const before = first.get(el); const after = el.getBoundingClientRect();
          const dx = before.left - after.left; const dy = before.top - after.top;
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
          el.classList.add('pm-shifting'); el.style.transition = 'none'; el.style.transform = `translate3d(${dx}px,${dy}px,0)`; shifted.push(el);
        }
        if (!shifted.length) return;
        requestAnimationFrame(() => {
          shifted.forEach(el => { el.style.transition = 'transform .34s cubic-bezier(.16,1,.3,1)'; el.style.transform = ''; });
          setTimeout(() => shifted.forEach(el => { el.classList.remove('pm-shifting'); el.style.transition = ''; el.style.transform = ''; }), 380);
        });
      };
      const movePlaceholder = (clientY) => {
        if (!drag?.placeholder) return;
        const items = getListItems();
        const beforeEl = items.find(el => { const r = el.getBoundingClientRect(); return clientY < r.top + r.height / 2; }) || null;
        if (getDivider() && beforeEl === getDivider()) return;
        const currentNext = drag.placeholder.nextElementSibling;
        if (beforeEl === currentNext || (!beforeEl && drag.placeholder === container.lastElementChild)) return;
        animateLayoutShift(() => { if (beforeEl) container.insertBefore(drag.placeholder, beforeEl); else container.appendChild(drag.placeholder); });
      };
      const autoScroll = (clientY) => {
        const r = container.getBoundingClientRect(); const edge = 46;
        if (clientY < r.top + edge) container.scrollTop -= Math.round((r.top + edge - clientY) / 4) + 4;
        else if (clientY > r.bottom - edge) container.scrollTop += Math.round((clientY - (r.bottom - edge)) / 4) + 4;
      };
      const startDrag = (e) => {
        const source = drag.item; const rect = source.getBoundingClientRect(); const cs = getComputedStyle(source);
        const placeholder = document.createElement('div'); placeholder.className = 'pm-drag-placeholder';
        placeholder.style.height = `${rect.height}px`; placeholder.style.marginBottom = cs.marginBottom;
        source.parentNode.insertBefore(placeholder, source);
        const ghost = source.cloneNode(true); ghost.classList.add('pm-lifted'); ghost.removeAttribute('id');
        ghost.style.left = `${rect.left}px`; ghost.style.top = `${rect.top}px`; ghost.style.width = `${rect.width}px`; ghost.style.height = `${rect.height}px`;
        ghost.style.transition = 'box-shadow .18s ease,border-color .18s ease,opacity .18s ease';
        document.body.appendChild(ghost);
        self._listDragActive = true;
        source.classList.add('pm-drag-source');
        drag.rect = rect; drag.ghost = ghost; drag.placeholder = placeholder; drag.started = true;
        drag.offsetX = e.clientX - rect.left; drag.offsetY = e.clientY - rect.top; lastClientY = e.clientY;
        setGhostTransform(0, 0); container.classList.add('pm-reordering'); applyJiggleDelays();
      };
      const onPointerDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (e.target.closest('button,input,textarea,select,a,[contenteditable="true"]')) return;
        const item = e.target.closest('.pm-item');
        if (!item || !container.contains(item)) return;
        drag = { item, ghost: null, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, rect: item.getBoundingClientRect(), started: false, placeholder: null, offsetX: 0, offsetY: 0 };
        item.addEventListener('lostpointercapture', () => finishDrag(true), { once: true });
        item.setPointerCapture?.(e.pointerId);
      };
      const onPointerMove = (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.startX; const dy = e.clientY - drag.startY; lastClientY = e.clientY;
        if (!drag.started) { if (Math.hypot(dx, dy) < MOVE_THRESHOLD) return; startDrag(e); }
        e.preventDefault(); clearFrame();
        raf = requestAnimationFrame(() => { setGhostTransform(dx, dy); movePlaceholder(lastClientY); autoScroll(lastClientY); });
      };
      const waitForTransition = (el, propertyName, fallback = 240) => new Promise(resolve => {
        let done = false; const finish = () => { if (done) return; done = true; el.removeEventListener('transitionend', onEnd); resolve(); };
        const onEnd = (ev) => { if (ev.target === el && (!propertyName || ev.propertyName === propertyName)) finish(); };
        el.addEventListener('transitionend', onEnd); setTimeout(finish, fallback);
      });
      const finishDrag = async (shouldSave = true) => {
        if (!drag) return; clearFrame(); const state = drag; drag = null;
        self._listDragActive = false;
        const source = state.item;
        try { source.releasePointerCapture?.(state.pointerId); } catch (e) {}
        if (!state.started) return;
        const ghost = state.ghost; const placeholder = state.placeholder;
        const removeGhost = () => { try { if (ghost && ghost.parentNode) ghost.remove(); } catch (e) {} };
        const removePlaceholder = () => { try { if (placeholder && placeholder.parentNode) placeholder.remove(); } catch (e) {} };
        try {
          const targetRect = placeholder.getBoundingClientRect();
          ghost.style.transition = 'transform .19s cubic-bezier(.2,.9,.2,1),box-shadow .19s ease,opacity .16s ease';
          setGhostTransform(targetRect.left - state.rect.left, targetRect.top - state.rect.top, ghost);
          await waitForTransition(ghost, 'transform', 230);
          if (placeholder.parentNode) {
            const firstRects = new Map(getListItems().map(el => [el, el.getBoundingClientRect()]));
            placeholder.parentNode.insertBefore(source, placeholder);
            source.classList.remove('pm-drag-source'); source.classList.add('pm-drop-pop');
            removePlaceholder();
            requestAnimationFrame(() => {
              for (const [el, before] of firstRects) {
                if (!el.isConnected || el === source) continue;
                const after = el.getBoundingClientRect();
                if (Math.abs(before.left - after.left) < .5 && Math.abs(before.top - after.top) < .5) continue;
                el.style.transition = 'none'; el.style.transform = `translate3d(${before.left - after.left}px,${before.top - after.top}px,0)`;
                requestAnimationFrame(() => { el.style.transition = 'transform .28s cubic-bezier(.16,1,.3,1)'; el.style.transform = ''; });
              }
              requestAnimationFrame(removeGhost);
            });
            setTimeout(() => { source.classList.remove('pm-drop-pop'); }, 360);
          } else {
            source.classList.remove('pm-drag-source');
            removeGhost(); removePlaceholder();
          }
        } catch (e) { removeGhost(); removePlaceholder(); }
        try { container.classList.remove('pm-reordering'); } catch (e) {}
        getListItems().forEach(el => {
          el.style.removeProperty('--pm-jiggle-delay');
          el.style.transform = '';
          el.style.transition = '';
          el.classList.remove('pm-shifting');
        });
        if (shouldSave) {
          try {
            const newOrder = [...document.querySelectorAll('#pm-list .pm-item')].map(el => el.dataset.id);
            const draggedId = source.dataset.id;
            const saveOrder = () => self._saveNewOrder(newOrder, draggedId, container).catch(e => console.log('[无水印] 保存排序失败:', e));
            if (window.requestIdleCallback) window.requestIdleCallback(saveOrder, { timeout: 1000 }); else setTimeout(saveOrder, 260);
          } catch (e) {}
        }
      };
      container.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointercancel', () => finishDrag(false));
      container._pmDragCleanup = () => {
        clearFrame(); if (drag?.ghost) drag.ghost.remove(); if (drag?.placeholder) drag.placeholder.remove();
        if (drag?.item) drag.item.classList.remove('pm-drag-source'); drag = null;
        container.classList.remove('pm-reordering');
        getListItems().forEach(el => { el.style.removeProperty('--pm-jiggle-delay'); el.style.transform = ''; el.style.transition = ''; el.classList.remove('pm-shifting'); });
        container.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('pointermove', onPointerMove);
      };
    },

    _bindCatDragEvents(container) {
      if (container._pmCatDragCleanup) container._pmCatDragCleanup();
      const self = this;
      const MOVE_THRESHOLD = 6; let drag = null; let raf = 0; let suppressClick = false;
      const clearFrame = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
      const getDraggableItems = () => [...container.querySelectorAll('.pm-cat-btn.pm-cat-draggable:not(.pm-cat-lifted):not(.pm-cat-source)')];
      const setGhostTransform = (dx, dy, ghost = drag?.ghost) => {
        if (!ghost) return;
        ghost.style.setProperty('--pm-cat-dx', `${dx}px`);
        ghost.style.setProperty('--pm-cat-dy', `${dy}px`);
        ghost.style.setProperty('--pm-cat-rotate', `${Math.max(-0.8, Math.min(0.8, dx / 180))}deg`);
      };
      const applyJiggleDelays = () => {
        getDraggableItems().forEach((el, i) => {
          el.style.setProperty('--pm-cat-jiggle-delay', `${-(i % 5) * 84}ms`);
        });
      };
      const animateLayoutShift = (mutate) => {
        const items = getDraggableItems(); const first = new Map(items.map(el => [el, el.getBoundingClientRect()])); mutate();
        const shifted = [];
        for (const el of items) {
          if (!el.isConnected) continue;
          const before = first.get(el); const after = el.getBoundingClientRect();
          if (Math.abs(before.left - after.left) < 0.5 && Math.abs(before.top - after.top) < 0.5) continue;
          el.classList.add('pm-cat-shifting'); el.style.transition = 'none'; el.style.transform = `translate3d(${before.left - after.left}px,${before.top - after.top}px,0)`; shifted.push(el);
        }
        if (!shifted.length) return;
        requestAnimationFrame(() => { shifted.forEach(el => { el.style.transition = 'transform .34s cubic-bezier(.16,1,.3,1)'; el.style.transform = ''; }); setTimeout(() => shifted.forEach(el => { el.classList.remove('pm-cat-shifting'); el.style.transition = ''; el.style.transform = ''; }), 380); });
      };
      const movePlaceholder = (clientX, clientY) => {
        if (!drag?.placeholder) return;
        const items = getDraggableItems();
        const beforeEl = items.find(el => { const r = el.getBoundingClientRect(); return (clientY >= r.top - 4 && clientY <= r.bottom + 4 && clientX < r.left + r.width / 2) || clientY < r.top + r.height / 2; }) || null;
        const addButton = container.querySelector('.pm-cat-add');
        if (beforeEl === drag.placeholder.nextElementSibling || (!beforeEl && drag.placeholder.nextElementSibling === addButton)) return;
        animateLayoutShift(() => { if (beforeEl) container.insertBefore(drag.placeholder, beforeEl); else container.insertBefore(drag.placeholder, addButton); });
      };
      const startDrag = (e) => {
        const source = drag.item; const rect = source.getBoundingClientRect();
        const placeholder = document.createElement('span'); placeholder.className = 'pm-cat-placeholder';
        placeholder.style.width = `${rect.width}px`; placeholder.style.height = `${rect.height}px`;
        source.parentNode.insertBefore(placeholder, source);
        const ghost = source.cloneNode(true); ghost.classList.add('pm-cat-lifted'); ghost.removeAttribute('id');
        ghost.style.left = `${rect.left}px`; ghost.style.top = `${rect.top}px`; ghost.style.width = `${rect.width}px`; ghost.style.height = `${rect.height}px`;
        ghost.style.transition = 'box-shadow .18s ease,border-color .18s ease'; document.body.appendChild(ghost);
        self._catDragActive = true;
        source.classList.add('pm-cat-source');
        drag.rect = rect; drag.ghost = ghost; drag.placeholder = placeholder; drag.started = true; suppressClick = true;
        drag.offsetX = e.clientX - rect.left; drag.offsetY = e.clientY - rect.top;
        setGhostTransform(0, 0); container.classList.add('pm-cat-reordering'); applyJiggleDelays();
      };
      const onPointerDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (e.target.closest('button,input,textarea,select')) return;
        const item = e.target.closest('.pm-cat-btn.pm-cat-draggable');
        if (!item || !container.contains(item)) return;
        drag = { item, ghost: null, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, rect: item.getBoundingClientRect(), started: false, placeholder: null, offsetX: 0, offsetY: 0 };
        item.setPointerCapture?.(e.pointerId);
      };
      const onPointerMove = (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.startX; const dy = e.clientY - drag.startY;
        if (!drag.started) { if (Math.hypot(dx, dy) < MOVE_THRESHOLD) return; startDrag(e); }
        e.preventDefault(); clearFrame(); raf = requestAnimationFrame(() => { setGhostTransform(dx, dy); movePlaceholder(e.clientX, e.clientY); });
      };
      const finishDrag = async (shouldSave = true) => {
        if (!drag) return; clearFrame(); const state = drag; drag = null;
        self._catDragActive = false;
        const source = state.item;
        try { source.releasePointerCapture?.(state.pointerId); } catch (e) {}
        if (!state.started) {
          if (state.placeholder && state.placeholder.parentNode) state.placeholder.remove();
          if (state.ghost && state.ghost.parentNode) state.ghost.remove();
          return;
        }
        const ghost = state.ghost; const placeholder = state.placeholder;
        try {
          // 1. ghost 飞到 placeholder 位置
          const phRect = placeholder.getBoundingClientRect();
          ghost.style.transition = 'transform .19s cubic-bezier(.2,.9,.2,1), box-shadow .19s ease, opacity .16s ease';
          ghost.style.transform = `translate3d(${phRect.left - state.rect.left}px, ${phRect.top - state.rect.top}px, 0) scale(1.05)`;
          await new Promise(r => setTimeout(r, 200));
          // 2. 记录当前位置用于 FLIP 动画
          const firstRects = new Map(getDraggableItems().filter(el => el !== source).map(el => [el, el.getBoundingClientRect()]));
          // 3. source 插入到 placeholder 位置
          if (placeholder.parentNode) {
            placeholder.parentNode.insertBefore(source, placeholder);
            source.classList.remove('pm-cat-source');
            source.classList.add('pm-cat-drop-pop');
          }
          placeholder.remove();
          ghost.remove();
          // 4. FLIP 动画：其他元素平滑过渡到新位置
          requestAnimationFrame(() => {
            for (const [el, before] of firstRects) {
              if (!el.isConnected) continue;
              const after = el.getBoundingClientRect();
              const dx = before.left - after.left;
              const dy = before.top - after.top;
              if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
              el.style.transition = 'none';
              el.style.transform = `translate3d(${dx}px,${dy}px,0)`;
              requestAnimationFrame(() => {
                el.style.transition = 'transform .28s cubic-bezier(.16,1,.3,1)';
                el.style.transform = '';
              });
            }
          });
          setTimeout(() => { source.classList.remove('pm-cat-drop-pop'); }, 360);
        } catch (e) {
          if (ghost && ghost.parentNode) ghost.remove();
          if (placeholder && placeholder.parentNode) placeholder.remove();
          source.classList.remove('pm-cat-source');
        }
        try { container.classList.remove('pm-cat-reordering'); } catch (e) {}
        getDraggableItems().forEach(el => {
          el.style.removeProperty('--pm-cat-jiggle-delay');
          el.style.transform = '';
          el.style.transition = '';
          el.classList.remove('pm-cat-shifting');
        });
        // 保存新顺序
        if (shouldSave) {
          const items = [...container.querySelectorAll('.pm-cat-btn.pm-cat-draggable:not(.pm-cat-lifted):not(.pm-cat-source)')];
          const newOrder = items.map(el => el.dataset.cat);
          self._catOrder = newOrder;
          await StorageService.saveCategoryOrder(newOrder);
        }
        setTimeout(() => { suppressClick = false; }, 0);
      };
      const onPointerUp = () => finishDrag(true);
      const onPointerCancel = () => finishDrag(false);
      const onClickCapture = (e) => {
        if (!suppressClick) return;
        suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
      };
      container.addEventListener('pointerdown', onPointerDown);
      container.addEventListener('click', onClickCapture, true);
      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      container._pmCatDragCleanup = () => {
        clearFrame(); if (drag?.ghost) drag.ghost.remove(); if (drag?.placeholder) drag.placeholder.remove();
        if (drag?.item) drag.item.classList.remove('pm-cat-source'); drag = null; suppressClick = false;
        container.classList.remove('pm-cat-reordering');
        getDraggableItems().forEach(el => { el.style.removeProperty('--pm-cat-jiggle-delay'); el.style.transform = ''; el.style.transition = ''; el.classList.remove('pm-cat-shifting'); });
        container.removeEventListener('pointerdown', onPointerDown);
        container.removeEventListener('click', onClickCapture, true);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
      };
    },

    async _saveNewOrder(newOrder, draggedId, container) {
      if (this._activeCategory === '常用') { this._frequentOrder = newOrder; await StorageService.saveFrequentOrder(newOrder); this.renderList(); return; }
      const draggedPrompt = this._prompts.find(p => p.id === draggedId);
      const crossedZone = draggedPrompt && (() => {
        const domIdx = newOrder.indexOf(draggedId);
        const favCount = newOrder.filter(id => this._prompts.find(pp => pp.id === id)?.favorite).length;
        return (draggedPrompt.favorite && domIdx >= favCount) || (!draggedPrompt.favorite && domIdx < favCount);
      })();
      let oldRect = null;
      if (crossedZone && container) { const el = container.querySelector(`[data-id="${draggedId}"]`); if (el) oldRect = el.getBoundingClientRect(); }
      const favIds = []; const normalIds = [];
      for (const id of newOrder) { const p = this._prompts.find(p => p.id === id); if (!p) continue; if (p.favorite) favIds.push(id); else normalIds.push(id); }
      favIds.forEach((id, i) => { const p = this._prompts.find(p => p.id === id); if (p) p.sortOrder = i; });
      normalIds.forEach((id, i) => { const p = this._prompts.find(p => p.id === id); if (p) p.sortOrder = i + 10000; });
      await StorageService.save(this._prompts); this.renderList();
      if (crossedZone && oldRect && container) {
        const newEl = container.querySelector(`[data-id="${draggedId}"]`);
        if (newEl) {
          const newRect = newEl.getBoundingClientRect(); const dx = oldRect.left - newRect.left; const dy = oldRect.top - newRect.top;
          if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
            newEl.style.transition = 'none'; newEl.style.transform = `translate3d(${dx}px,${dy}px,0)`; newEl.style.zIndex = '10';
            requestAnimationFrame(() => { newEl.style.transition = 'transform .4s cubic-bezier(.16,1,.3,1)'; newEl.style.transform = ''; setTimeout(() => { newEl.style.transition = ''; newEl.style.transform = ''; newEl.style.zIndex = ''; }, 450); });
          }
        }
      }
    },

    async _fillPrompt(id) {
      const prompt = this._prompts.find(p => p.id === id); if (!prompt) return;
      let content = prompt.content; let replaced = false;
      const vars = parseTemplate(content);
      if (vars.length > 0) {
        const args = readArgsFromEditor();
        if (args) {
          const result = resolveArgs(vars, args.tokens);
          if (result.errors.length > 0) { showToast(result.errors[0]); return; }
          content = fillTemplate(content, vars, result); replaced = true; SiteAdapter.clearInput();
        } else { content = fillTemplate(content, vars, { values: {}, skipped: new Set(), errors: [] }); }
      }
      const success = SiteAdapter.insertText(content, replaced ? 'replace' : 'append');
      if (success) {
        prompt.usageCount = (prompt.usageCount || 0) + 1; prompt.lastUsedAt = new Date().toISOString();
        await StorageService.save(this._prompts); this.renderList();
        showToast(replaced ? '已替换变量并填入输入框' : '已追加到输入框');
      } else { showToast('未找到输入框，请点击豆包输入区域后再试'); }
    },

    async _fillAndSendPrompt(id) {
      const prompt = this._prompts.find(p => p.id === id); if (!prompt) return;
      let content = prompt.content;
      const vars = parseTemplate(content);
      if (vars.length > 0) {
        const args = readArgsFromEditor();
        if (args) {
          const result = resolveArgs(vars, args.tokens);
          if (result.errors.length > 0) { showToast(result.errors[0]); return; }
          content = fillTemplate(content, vars, result); SiteAdapter.clearInput();
        } else { content = fillTemplate(content, vars, { values: {}, skipped: new Set(), errors: [] }); }
      }
      const success = SiteAdapter.insertText(content, 'replace');
      if (!success) { showToast('未找到输入框，请点击豆包输入区域后再试'); return; }
      prompt.usageCount = (prompt.usageCount || 0) + 1; prompt.lastUsedAt = new Date().toISOString();
      await StorageService.save(this._prompts); this.renderList();
      showToast('已填入，等待发送...');
      for (let i = 0; i < 225; i++) {
        await new Promise(r => setTimeout(r, 200));
        const sendBtn = SiteAdapter.findSendButton();
        if (sendBtn && !sendBtn.disabled) { sendBtn.click(); return; }
      }
      showToast('发送按钮未就绪，请手动点击发送');
    },

    async _deletePrompt(id) {
      const prompt = this._prompts.find(p => p.id === id); if (!prompt) return;
      if (!await customConfirm(`确定删除「${escHtml(prompt.title)}」？`, { danger: true })) return;
      this._prompts = this._prompts.filter(p => p.id !== id);
      await StorageService.save(this._prompts); this.renderList(); this.renderCategories(); showToast('已删除');
    },

    async _toggleFavorite(id) {
      const prompt = this._prompts.find(p => p.id === id); if (!prompt) return;
      prompt.favorite = !prompt.favorite;
      await StorageService.save(this._prompts); this.renderList();
    },

    async _handleImport(e) {
      const file = e.target.files[0]; if (!file) return; e.target.value = '';
      try {
        const imported = await StorageService.importJSON(file);
        const existingMap = new Map(this._prompts.map(p => [p.id, p]));
        const toAdd = []; const conflicts = [];
        for (const imp of imported) {
          const local = existingMap.get(imp.id);
          if (!local) { toAdd.push(imp); } else { if (local.content === imp.content && local.updatedAt === imp.updatedAt) continue; conflicts.push({ local, imported: imp }); }
        }
        if (conflicts.length === 0) { this._prompts.push(...toAdd); await StorageService.save(this._prompts); this.renderList(); showToast(`已导入 ${toAdd.length} 条提示词`); return; }
        this._showImportConflictDialog(toAdd, conflicts);
      } catch (err) { showToast('导入失败：' + err.message); }
    },

    _showImportConflictDialog(toAdd, conflicts) {
      const overlay = document.createElement('div'); overlay.className = 'pm-modal-overlay';
      const resolutions = new Map(); let mode = null;
      const renderConflictList = () => {
        const listEl = overlay.querySelector('#pm-conflict-list'); if (!listEl) return;
        listEl.innerHTML = conflicts.map((c, i) => {
          const localTime = new Date(c.local.updatedAt).toLocaleString('zh-CN');
          const importTime = new Date(c.imported.updatedAt).toLocaleString('zh-CN');
          const localNewer = new Date(c.local.updatedAt) >= new Date(c.imported.updatedAt);
          const current = resolutions.get(c.imported.id);
          return `<div class="pm-conflict-item" data-idx="${i}">
            <div class="pm-conflict-title">${escHtml(c.imported.title || c.local.title)}</div>
            <div class="pm-conflict-compare">
              <div class="pm-conflict-side"><div class="pm-conflict-side-header"><span>本地</span><span class="${localNewer ? 'pm-conflict-newer' : ''}">${localTime}</span></div><div class="pm-conflict-side-content">${escHtml(c.local.content)}</div></div>
              <div class="pm-conflict-side"><div class="pm-conflict-side-header"><span>导入</span><span class="${!localNewer ? 'pm-conflict-newer' : ''}">${importTime}</span></div><div class="pm-conflict-side-content">${escHtml(c.imported.content)}</div></div>
            </div>
            <div class="pm-conflict-actions">
              <button class="pm-conflict-btn${current === 'skip' ? ' pm-conflict-active' : ''}" data-idx="${i}" data-action="skip">保留本地</button>
              <button class="pm-conflict-btn${current === 'replace' ? ' pm-conflict-active' : ''}" data-idx="${i}" data-action="replace">使用导入</button>
            </div></div>`;
        }).join('');
        listEl.querySelectorAll('.pm-conflict-btn').forEach(btn => {
          btn.addEventListener('click', () => { resolutions.set(conflicts[parseInt(btn.dataset.idx)].imported.id, btn.dataset.action); renderConflictList(); });
        });
      };
      overlay.innerHTML = `<div class="pm-modal pm-conflict-modal">
        <h4>导入冲突（${conflicts.length} 条）</h4>
        <div class="pm-conflict-desc">以下提示词 ID 相同但内容不同，请选择处理方式：</div>
        <div class="pm-conflict-global"><button class="pm-conflict-global-btn" data-mode="replace">全部替换</button><button class="pm-conflict-global-btn" data-mode="newest">按时间最新</button><button class="pm-conflict-global-btn" data-mode="skip">全部跳过</button></div>
        <div class="pm-conflict-list" id="pm-conflict-list"></div>
        <div class="pm-modal-btns"><button class="pm-btn-cancel" id="pm-conflict-cancel">取消</button><button class="pm-btn-save" id="pm-conflict-confirm">确认导入</button></div>
      </div>`;
      document.body.appendChild(overlay); renderConflictList();
      overlay.querySelectorAll('.pm-conflict-global-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          mode = btn.dataset.mode;
          overlay.querySelectorAll('.pm-conflict-global-btn').forEach(b => b.classList.remove('pm-conflict-active')); btn.classList.add('pm-conflict-active');
          if (mode === 'replace') conflicts.forEach(c => resolutions.set(c.imported.id, 'replace'));
          else if (mode === 'skip') conflicts.forEach(c => resolutions.set(c.imported.id, 'skip'));
          else if (mode === 'newest') conflicts.forEach(c => resolutions.set(c.imported.id, new Date(c.imported.updatedAt) > new Date(c.local.updatedAt) ? 'replace' : 'skip'));
          renderConflictList();
        });
      });
      overlay.querySelector('#pm-conflict-cancel').addEventListener('click', () => overlay.remove());
      overlay.querySelector('#pm-conflict-confirm').addEventListener('click', async () => {
        if (!mode) { showToast('请先选择处理方式'); return; }
        for (const [id, action] of resolutions) { if (action === 'replace') { const imp = conflicts.find(c => c.imported.id === id)?.imported; if (imp) { const idx = this._prompts.findIndex(p => p.id === id); if (idx !== -1) this._prompts[idx] = imp; } } }
        this._prompts.push(...toAdd); await StorageService.save(this._prompts); overlay.remove(); this.renderList();
        showToast(`已导入 ${toAdd.length} 条新增，${[...resolutions.values()].filter(a => a === 'replace').length} 条替换`);
      });
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    },

    showEditModal(id, prefill) {
      this._editingId = id || null;
      const prompt = id ? this._prompts.find(p => p.id === id) : null;
      const defaultCategory = (this._activeCategory !== '全部' && this._activeCategory !== '常用') ? this._activeCategory : '通用模板';
      const data = prompt || prefill || { category: defaultCategory };
      const modalCategories = [...new Set([...this._getCategoryList(), data.category || defaultCategory].filter(Boolean))];
      const selectedCategory = modalCategories.includes(data.category) ? data.category : (modalCategories[0] || defaultCategory);
      const overlay = document.createElement('div'); overlay.className = 'pm-modal-overlay';
      overlay.innerHTML = `<div class="pm-modal">
        <h4>${prompt ? '编辑提示词' : '新增提示词'}</h4>
        <label>标题</label><input id="pm-edit-title" type="text" value="${escAttr(data.title || '')}" placeholder="给提示词起个名字" />
        <label>内容</label><textarea id="pm-edit-content" placeholder="输入提示词内容...">${escHtml(data.content || '')}</textarea>
        <div class="pm-help-text">使用 {变量名} 定义占位符，{变量名='默认值'} 设置默认值。传参格式：'参数1|参数2' 或 "参数1|参数2"，空位跳过</div>
        <label>分类</label>
        <select id="pm-edit-category" class="pm-select-native" aria-hidden="true" tabindex="-1">
          ${modalCategories.map(c => `<option value="${escAttr(c)}"${selectedCategory === c ? ' selected' : ''}>${escHtml(c)}</option>`).join('')}
        </select>
        <div class="pm-select" data-for="pm-edit-category">
          <button type="button" class="pm-select-trigger" aria-haspopup="listbox" aria-expanded="false">
            <span class="pm-select-value">${escHtml(selectedCategory)}</span>
            <span class="pm-select-arrow" aria-hidden="true">⌄</span>
          </button>
          <div class="pm-select-menu" role="listbox" tabindex="-1">
            ${modalCategories.map(c => `
              <button type="button" class="pm-select-option${selectedCategory === c ? ' pm-selected' : ''}" role="option" aria-selected="${selectedCategory === c ? 'true' : 'false'}" data-value="${escAttr(c)}">
                <span>${escHtml(c)}</span><span class="pm-select-check" aria-hidden="true">✓</span>
              </button>
            `).join('')}
          </div>
        </div>
        <label>标签（逗号分隔）</label><input id="pm-edit-tags" type="text" value="${(data.tags || []).join(', ')}" placeholder="标签1, 标签2" />
        <div class="pm-modal-btns"><button class="pm-btn-cancel" id="pm-edit-cancel">取消</button><button class="pm-btn-save" id="pm-edit-save">保存</button></div>
      </div>`;
      document.body.appendChild(overlay);
      setTimeout(() => document.getElementById('pm-edit-title')?.focus(), 50);
      this._bindCategorySelect(overlay);
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
      document.getElementById('pm-edit-cancel').addEventListener('click', () => overlay.remove());
      document.getElementById('pm-edit-save').addEventListener('click', async () => { await this._savePrompt(overlay); });
      overlay.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter') this._savePrompt(overlay); });
    },

    _bindCategorySelect(overlay) {
      const select = overlay.querySelector('#pm-edit-category');
      const wrap = overlay.querySelector('.pm-select[data-for="pm-edit-category"]');
      if (!select || !wrap) return;

      const trigger = wrap.querySelector('.pm-select-trigger');
      const valueText = wrap.querySelector('.pm-select-value');
      const options = [...wrap.querySelectorAll('.pm-select-option')];

      const close = () => {
        wrap.classList.remove('pm-open');
        trigger.setAttribute('aria-expanded', 'false');
      };
      const open = () => {
        wrap.classList.add('pm-open');
        trigger.setAttribute('aria-expanded', 'true');
      };
      const setValue = value => {
        select.value = value;
        valueText.textContent = value;
        options.forEach(btn => {
          const selected = btn.dataset.value === value;
          btn.classList.toggle('pm-selected', selected);
          btn.setAttribute('aria-selected', selected ? 'true' : 'false');
        });
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const focusOption = offset => {
        const current = Math.max(0, options.findIndex(btn => btn.dataset.value === select.value));
        const next = options[(current + offset + options.length) % options.length];
        next?.focus();
      };

      trigger.addEventListener('click', e => {
        e.stopPropagation();
        wrap.classList.contains('pm-open') ? close() : open();
      });
      trigger.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); open(); focusOption(0); }
        if (e.key === 'ArrowUp') { e.preventDefault(); open(); focusOption(-1); }
        if (e.key === 'Escape') close();
      });
      options.forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          setValue(btn.dataset.value);
          close();
          trigger.focus();
        });
        btn.addEventListener('keydown', e => {
          const idx = options.indexOf(btn);
          if (e.key === 'ArrowDown') { e.preventDefault(); options[(idx + 1) % options.length]?.focus(); }
          if (e.key === 'ArrowUp') { e.preventDefault(); options[(idx - 1 + options.length) % options.length]?.focus(); }
          if (e.key === 'Home') { e.preventDefault(); options[0]?.focus(); }
          if (e.key === 'End') { e.preventDefault(); options[options.length - 1]?.focus(); }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setValue(btn.dataset.value);
            close();
            trigger.focus();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
            trigger.focus();
          }
        });
      });
      overlay.addEventListener('click', e => { if (!wrap.contains(e.target)) close(); });
    },

    async _savePrompt(overlay) {
      const title = document.getElementById('pm-edit-title').value.trim();
      const content = document.getElementById('pm-edit-content').value.trim();
      const category = document.getElementById('pm-edit-category').value;
      const tagsStr = document.getElementById('pm-edit-tags').value.trim();
      const tags = tagsStr ? tagsStr.split(/[,，]/).map(t => t.trim()).filter(Boolean) : [];
      if (!title) { showToast('请输入标题'); return; }
      if (!content) { showToast('请输入提示词内容'); return; }
      if (this._editingId) {
        const idx = this._prompts.findIndex(p => p.id === this._editingId);
        if (idx !== -1) this._prompts[idx] = PromptService.update(this._prompts[idx], { title, content, category, tags });
      } else {
        this._prompts.filter(p => !p.favorite).forEach(p => { p.sortOrder = (p.sortOrder || 10000) + 1; });
        this._prompts.push(PromptService.create({ title, content, category, tags, sortOrder: 10000 }));
      }
      await StorageService.save(this._prompts); overlay.remove(); this.renderList(); this.renderCategories();
      showToast(this._editingId ? '已更新' : '已添加');
    },
  };

  // ── 提示词库：独立悬浮按钮和面板 ──────────────────────────────────────────
  const PROMPT_BUTTON_HOST_ID = "doubao-prompt-button-host";
  const PROMPT_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M8 7h6"/><path d="M8 11h8"/></g></svg>`;

  let promptBtnElement = null;
  let promptModalElement = null;

  function createPromptFloatingButton() {
    if (document.getElementById(PROMPT_BUTTON_HOST_ID)) return;
    const wrapper = document.createElement("div");
    wrapper.id = PROMPT_BUTTON_HOST_ID;
    const style = document.createElement("style");
    style.textContent = `
      #${PROMPT_BUTTON_HOST_ID} {
        --prompt-accent: #4f7cff;
        --prompt-accent-2: #78d7ff;
        --prompt-ink: #1f2937;
        --prompt-border: rgba(229,231,235,0.92);
        --prompt-glass: rgba(255,255,255,0.92);
        position: fixed;
        right: 24px;
        bottom: 92px;
        z-index: 2147483646;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      #doubao-prompt-btn {
        position: relative;
        width: 54px;
        height: 54px;
        border: 1px solid var(--prompt-border);
        border-radius: 18px;
        color: var(--prompt-ink);
        background:
          radial-gradient(circle at 28% 18%, rgba(79,124,255,0.18), transparent 28%),
          var(--prompt-glass);
        box-shadow: 0 16px 38px rgba(15,23,42,0.14);
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
      #doubao-prompt-btn:hover {
        transform: translateY(-2px) scale(1.02);
        color: var(--prompt-accent);
        border-color: rgba(79,124,255,0.42);
        box-shadow: 0 22px 46px rgba(79,124,255,0.20), 0 12px 28px rgba(15,23,42,0.12);
      }
      #doubao-prompt-btn:active { transform: translateY(0) scale(.98); }
      #doubao-prompt-btn::after {
        content: "";
        position: absolute;
        inset: -5px;
        border-radius: 22px;
        border: 1px solid rgba(79,124,255,.28);
        animation: promptPulse 1.8s ease-out infinite;
        pointer-events: none;
      }
      @keyframes promptPulse {
        0% { opacity: .70; transform: scale(.96); }
        100% { opacity: 0; transform: scale(1.16); }
      }
    `;
    wrapper.appendChild(style);
    const btn = document.createElement("button");
    btn.id = "doubao-prompt-btn";
    btn.type = "button";
    btn.innerHTML = PROMPT_ICON_SVG;
    btn.title = "提示词库";
    btn.setAttribute("aria-label", "提示词库");
    btn.addEventListener("click", () => {
      if (promptModalElement && promptModalElement.classList.contains("show")) { closePromptModal(); }
      else { openPromptModal(); }
    });
    wrapper.appendChild(btn);
    document.body.appendChild(wrapper);
    promptBtnElement = wrapper;
  }

  function openPromptModal() {
    if (modalElement && modalElement.classList.contains("show")) {
      modalElement.classList.remove("show");
      document.documentElement.classList.remove("doubao-nomark-modal-open");
    }
    if (!promptModalElement) createPromptModal();
    promptModalElement.classList.add("show");
    document.documentElement.classList.add("doubao-nomark-modal-open");
    LibraryUI.render();
    showPromptHelpOnFirstOpen();
  }

  function closePromptModal() {
    if (promptModalElement) promptModalElement.classList.remove("show");
    document.documentElement.classList.remove("doubao-nomark-modal-open");
  }

  async function showPromptHelpOnFirstOpen() {
    try {
      const seen = await GM_getValue(PromptConfig.HELP_SEEN_KEY);
      if (!seen) await showPromptHelpDialog({ remember: true });
    } catch (e) {
      console.log('[无水印] 首次提示词说明弹出失败:', e);
    }
  }

  function createPromptModal() {
    if (document.getElementById("doubao-prompt-modal")) return;
    const modal = document.createElement("div");
    modal.id = "doubao-prompt-modal";
    const style = document.createElement("style");
    style.textContent = `
      #doubao-prompt-modal {
        --nomark-accent: #ff6060;
        --nomark-accent-2: #ff9a9a;
        --nomark-accent-soft: #fff1f1;
        --nomark-ink: #1f2937;
        --nomark-muted: #6b7280;
        --nomark-soft: #f6f7f9;
        --nomark-border: rgba(229, 231, 235, 0.92);
        --nomark-card: rgba(255, 255, 255, 0.96);
        position: fixed; right: 24px; bottom: 160px;
        width: 410px; max-width: calc(100vw - 48px);
        height: min(72vh, 760px);
        z-index: 2147483645;
        transform: translateY(12px) scale(.98);
        opacity: 0; pointer-events: none;
        transition: transform .24s cubic-bezier(.2,.8,.2,1), opacity .18s ease, box-shadow .18s ease;
        background: var(--nomark-card);
        border: 1px solid var(--nomark-border);
        border-radius: 20px;
        display: flex; flex-direction: column; overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", "Microsoft YaHei", sans-serif;
        font-size: 14px; color: var(--nomark-ink);
        box-shadow: 0 18px 55px rgba(15,23,42,.18), 0 0 0 1px rgba(255,255,255,.62);
      }
      #doubao-prompt-modal.show { transform: translateY(0) scale(1); opacity: 1; pointer-events: auto; }
      .pm-topbar {
        display: flex; align-items: center; gap: 8px;
        padding: 12px 14px; border-bottom: 1px solid var(--nomark-border);
        flex-shrink: 0; background: var(--nomark-card);
      }
      .pm-topbar h3 { margin: 0; font-size: 15px; font-weight: 600; flex-shrink: 0; }
      .pm-topbar-spacer { flex: 1; }
      .pm-topbar-btn {
        min-height: 30px; padding: 0 10px; border-radius: 12px;
        border: 1px solid var(--nomark-border); background: var(--nomark-soft);
        color: var(--nomark-muted); cursor: pointer; font-size: 12px; font-weight: 600;
        display: inline-flex; align-items: center; gap: 5px;
        transition: all .15s;
      }
      #pm-btn-help { width: 30px; padding: 0; justify-content: center; font-weight: 800; }
      .pm-topbar-btn:hover { background: var(--nomark-border); color: var(--nomark-ink); border-color: var(--nomark-border); }
      .pm-add-bar {
        padding: 10px 14px; border-top: 1px solid var(--nomark-border);
        flex-shrink: 0; display: flex; gap: 8px; background: var(--nomark-card);
      }
      .pm-add-btn, .pm-export-btn {
        min-height: 40px; font-size: 12px; font-weight: 700; border-radius: 10px;
        border: 1px solid var(--nomark-border); cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center; gap: 5px;
        transition: background .16s ease, border-color .16s ease, color .16s ease, transform .12s ease, box-shadow .16s ease;
      }
      .pm-add-btn { flex: 1; background: var(--nomark-ink); border-color: var(--nomark-ink); color: var(--nomark-card); }
      .pm-export-btn { padding: 0 14px; background: var(--nomark-card); color: var(--nomark-ink); }
      .pm-add-btn:hover, .pm-export-btn:hover { box-shadow: 0 5px 16px rgba(0,0,0,.1); }
      .pm-export-btn:hover { background: var(--nomark-soft); border-color: var(--nomark-border); }
      .pm-search-bar {
        padding: 12px 14px; border-bottom: 1px solid var(--nomark-border);
        flex-shrink: 0; background: var(--nomark-card);
      }
      .pm-search-bar input {
        width: 100%; border: 1px solid var(--nomark-border); border-radius: 12px;
        background: var(--nomark-soft); color: var(--nomark-ink);
        padding: 10px 12px; font-size: 13px; outline: none;
        transition: border-color .16s ease, box-shadow .16s ease;
        box-sizing: border-box;
      }
      .pm-search-bar input:focus {
        border-color: var(--nomark-accent, #ff6060);
        box-shadow: 0 0 0 4px rgba(255,96,96,0.12);
        background: var(--nomark-card);
      }
      .pm-categories {
        display: flex; gap: 8px; padding: 10px 14px; flex-wrap: wrap;
        overflow-x: auto; border-bottom: 1px solid var(--nomark-border);
        background: var(--nomark-card); flex-shrink: 0;
      }
      .pm-cat-btn, .pm-cat-add {
        min-height: 30px; padding: 0 10px;
        border: 1px solid var(--nomark-border); background: var(--nomark-soft);
        color: var(--nomark-muted); cursor: pointer;
        display: inline-flex; align-items: center; gap: 5px;
        white-space: nowrap; font-size: 12px; font-weight: 600;
        border-radius: 12px; transition: all .15s;
      }
      .pm-cat-btn:hover, .pm-cat-add:hover { background: var(--nomark-border); color: var(--nomark-ink); }
      .pm-cat-btn.pm-active { background: var(--nomark-ink); border-color: var(--nomark-ink); color: var(--nomark-card); }
      .pm-cat-del {
        margin-left: 2px; padding: 0; border: none; background: transparent;
        color: inherit; cursor: pointer; font-size: 14px; line-height: 1; opacity: .55;
      }
      .pm-cat-del:hover { opacity: 1; color: #ef4444; }
      .pm-cat-btn.pm-active .pm-cat-del:hover { color: currentColor; }
      .pm-cat-add { border-style: dashed; background: transparent; color: var(--nomark-muted); }
      .pm-cat-label { display: inline-flex; align-items: center; gap: 5px; transform-origin: center center; }
      .pm-cat-btn.pm-cat-draggable { cursor: grab; transition: transform .2s ease, box-shadow .2s ease; }
      .pm-cat-btn.pm-cat-draggable:active { cursor: grabbing; }
      .pm-cat-btn.pm-cat-source { display: none !important; }
      .pm-cat-btn.pm-cat-lifted {
        position: fixed !important; margin: 0 !important;
        z-index: 2147483647; pointer-events: none; opacity: .99;
        background: var(--nomark-card); border-color: var(--nomark-accent, #ff6060);
        box-shadow: 0 18px 38px rgba(0,0,0,.22), 0 0 0 1px rgba(255,96,96,.18);
        transform: translate3d(var(--pm-cat-dx,0px), var(--pm-cat-dy,0px), 0) scale(1.05) rotate(var(--pm-cat-rotate,.35deg));
        transform-origin: center center;
        will-change: transform;
        transition: box-shadow .18s ease, border-color .18s ease, opacity .18s ease;
      }
      .pm-categories.pm-cat-reordering .pm-cat-btn.pm-cat-draggable:not(.pm-cat-lifted):not(.pm-cat-source) {
        transition: transform .34s cubic-bezier(.16,1,.3,1), box-shadow .18s ease, border-color .18s ease;
      }
      .pm-categories.pm-cat-reordering .pm-cat-btn.pm-cat-draggable:not(.pm-cat-lifted):not(.pm-cat-source) .pm-cat-label {
        animation: pmCatJiggle .62s ease-in-out infinite alternate;
        animation-delay: var(--pm-cat-jiggle-delay,0ms);
      }
      .pm-cat-btn.pm-cat-shifting { z-index: 1; }
      .pm-cat-placeholder {
        height: 28px; display: inline-flex; flex-shrink: 0;
        border: 1px dashed rgba(255,96,96,.38); border-radius: 12px;
        background: linear-gradient(90deg, rgba(255,96,96,.075), rgba(255,96,96,.04));
        transition: width .24s cubic-bezier(.16,1,.3,1), transform .24s cubic-bezier(.16,1,.3,1);
      }
      .pm-cat-btn.pm-cat-drop-pop { animation: pmCatDropPop .32s cubic-bezier(.2,1.25,.2,1); }
      @keyframes pmCatJiggle {
        0% { transform: translate3d(-.35px,0,0) rotate(-.22deg); }
        50% { transform: translate3d(.25px,-.25px,0) rotate(.12deg); }
        100% { transform: translate3d(.35px,.15px,0) rotate(.24deg); }
      }
      @keyframes pmCatDropPop { 0% { transform: scale(1.08); } 58% { transform: scale(.96); } 100% { transform: scale(1); } }
      .pm-list { flex: 1; overflow-y: auto; padding: 8px 14px; }
      .pm-list::-webkit-scrollbar { width: 8px; }
      .pm-list::-webkit-scrollbar-thumb { background: rgba(0,0,0,.12); border-radius: 4px; }
      .pm-empty { text-align: center; padding: 40px 0; color: var(--nomark-muted); font-size: 13px; }
      .pm-fav-divider {
        display: flex; align-items: center; gap: 8px; padding: 8px 0; margin: 4px 0;
        font-size: 11px; color: var(--nomark-muted); text-transform: uppercase; letter-spacing: .5px;
      }
      .pm-fav-divider::before, .pm-fav-divider::after { content: ''; flex: 1; height: 1px; background: var(--nomark-border); }
      .pm-item {
        position: relative; padding: 14px; margin-bottom: 10px;
        border: 1px solid var(--nomark-border); border-radius: 16px;
        background: var(--nomark-card); cursor: grab; user-select: none;
        -webkit-user-select: none; touch-action: pan-y; will-change: transform;
        transition: border-color .16s ease, background .16s ease, box-shadow .16s ease, transform .16s ease;
      }
      .pm-item:hover {
        border-color: var(--nomark-border); box-shadow: 0 10px 24px rgba(0,0,0,.065);
        transform: translateY(-1px);
      }
      .pm-item:active { cursor: grabbing; }
      .pm-item-inner { transform-origin: center center; will-change: transform; }
      .pm-item-title {
        display: flex; align-items: flex-start; gap: 8px;
        margin-bottom: 7px; min-width: 0;
        color: var(--nomark-ink); font-size: 14px; font-weight: 700; line-height: 1.35;
      }
      .pm-item-title > span:not(.pm-item-title-tags) {
        min-width: 0; overflow: hidden; text-overflow: ellipsis; word-break: break-word;
      }
      .pm-item-title .pm-fav { color: #f59e0b; font-size: 12px; line-height: 1.6; }
      .pm-item-title-tags {
        margin-left: auto; display: flex; gap: 5px; flex-wrap: wrap;
        justify-content: flex-end; max-width: 48%;
      }
      .pm-tag {
        display: inline-block; padding: 1px 6px; border-radius: 4px;
        font-size: 10px; background: var(--nomark-soft); color: var(--nomark-muted);
      }
      .pm-var-tag { background: rgba(255,96,96,.08); color: var(--nomark-accent, #ff6060); }
      .pm-item-preview {
        max-height: 44px; overflow: hidden; margin-bottom: 10px;
        color: var(--nomark-muted); font-size: 12px; line-height: 1.6;
      }
      .pm-item-preview:hover { overflow-y: auto; scrollbar-width: none; }
      .pm-item-preview:hover::-webkit-scrollbar { display: none; }
      .pm-item-meta { display: flex; flex-direction: column; align-items: stretch; gap: 10px; }
      .pm-item-tags { display: flex; gap: 6px; flex-wrap: wrap; min-width: 0; }
      .pm-item-actions { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; align-items: stretch; }
      .pm-item-actions button {
        width: 100%; min-width: 0; min-height: 34px;
        padding: 0 8px; border-radius: 10px;
        border: 1px solid var(--nomark-border); background: var(--nomark-soft);
        cursor: pointer; font-size: 11px; color: var(--nomark-muted);
        font-weight: 650; display: inline-flex; align-items: center;
        justify-content: center; gap: 5px;
        transition: border-color .15s ease, background .15s ease, color .15s ease, transform .15s ease;
      }
      .pm-item-actions button:hover {
        background: var(--nomark-border); color: var(--nomark-ink);
        border-color: var(--nomark-border); transform: translateY(-1px);
      }
      #doubao-prompt-modal .pm-item-actions button,
      #doubao-prompt-modal .pm-add-btn,
      #doubao-prompt-modal .pm-export-btn {
        min-height: 36px; padding: 0 6px; gap: 0;
      }
      #doubao-prompt-modal .pm-item-actions button .pm-btn-label,
      #doubao-prompt-modal .pm-add-btn .pm-btn-label,
      #doubao-prompt-modal .pm-export-btn .pm-btn-label {
        display: none;
      }
      #doubao-prompt-modal .pm-item-actions button .pm-btn-ico,
      #doubao-prompt-modal .pm-add-btn .pm-btn-ico,
      #doubao-prompt-modal .pm-export-btn .pm-btn-ico {
        font-size: 15px;
      }
      #doubao-prompt-modal .pm-add-bar { gap: 8px; align-items: stretch; }
      #doubao-prompt-modal .pm-add-btn { flex: 1; }
      #doubao-prompt-modal .pm-export-btn { flex: 0 0 84px; width: 84px; min-width: 84px; }
      .pm-btn-ico { font-size: 12px; }
      .pm-list.pm-reordering { user-select: none; }
      .pm-list.pm-reordering .pm-item:not(.pm-lifted) { transition: transform .34s cubic-bezier(.16,1,.3,1), box-shadow .18s ease, border-color .18s ease, background .18s ease; }
      .pm-list.pm-reordering .pm-item:not(.pm-lifted) .pm-item-inner {
        animation: pmNeighborJiggle .62s ease-in-out infinite alternate;
        animation-delay: var(--pm-jiggle-delay,0ms);
      }
      .pm-item.pm-drag-source { display: none !important; }
      .pm-item.pm-lifted {
        position: fixed !important; margin: 0 !important;
        z-index: 2147483647; pointer-events: none; cursor: grabbing; opacity: .99;
        border-color: var(--nomark-accent, #ff6060);
        background: var(--nomark-card);
        box-shadow: 0 28px 64px rgba(0,0,0,.24), 0 0 0 1px rgba(255,96,96,.18);
        transform: translate3d(var(--pm-drag-x,0px), var(--pm-drag-y,0px), 0) scale(1.035) rotate(var(--pm-drag-rotate,.45deg));
        transform-origin: center center;
        will-change: transform,left,top;
        transition: box-shadow .18s ease, border-color .18s ease, opacity .18s ease, filter .18s ease;
        filter: saturate(1.02);
      }
      .pm-item.pm-lifted .pm-item-inner { animation: pmLiftedJiggle .46s ease-in-out infinite alternate; }
      .pm-item.pm-drop-pop { animation: pmDropPop .32s cubic-bezier(.2,1.25,.2,1); }
      .pm-item.pm-drop-pop .pm-item-inner { animation: none; }
      @keyframes pmDropPop { 0% { transform: scale(1.08); } 58% { transform: scale(.96); } 100% { transform: scale(1); } }
      @keyframes pmNeighborJiggle {
        0% { transform: translate3d(-.35px,0,0) rotate(-.22deg); }
        50% { transform: translate3d(.25px,-.25px,0) rotate(.12deg); }
        100% { transform: translate3d(.35px,.15px,0) rotate(.24deg); }
      }
      @keyframes pmLiftedJiggle { 0% { transform: rotate(-.38deg); } 100% { transform: rotate(.48deg); } }
      .pm-drag-placeholder {
        border: 2px dashed rgba(255,96,96,.38); border-radius: 16px;
        background: linear-gradient(90deg, rgba(255,96,96,.075), rgba(255,96,96,.04));
        margin-bottom: 10px; transition: height .24s cubic-bezier(.16,1,.3,1), transform .24s cubic-bezier(.16,1,.3,1), opacity .18s ease;
      }
      .pm-shifting { will-change: transform; z-index: 1; }
      .pm-modal-overlay {
        --nomark-accent: #ff6060;
        --nomark-accent-2: #ff9a9a;
        --nomark-ink: #1f2937;
        --nomark-muted: #6b7280;
        --nomark-soft: #f6f7f9;
        --nomark-border: rgba(229, 231, 235, 0.92);
        --nomark-card: rgba(255, 255, 255, 0.96);
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.4); z-index: 2147483647;
        display: flex; align-items: center; justify-content: center;
      }
      .pm-modal {
        background: var(--nomark-card, #fff); border-radius: 16px; padding: 24px;
        width: 420px; max-width: 90vw; max-height: 80vh; overflow-y: auto;
        box-shadow: 0 20px 60px rgba(0,0,0,0.2);
      }
      .pm-modal h4 { margin: 0 0 16px; font-size: 16px; font-weight: 600; }
      .pm-modal label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 4px; color: var(--nomark-muted); }
      .pm-modal input, .pm-modal textarea, .pm-modal select {
        width: 100%; padding: 10px 12px; border-radius: 12px; font-size: 13px;
        border: 1px solid var(--nomark-border); background: var(--nomark-soft);
        outline: none; margin-bottom: 12px; box-sizing: border-box;
        transition: border-color .16s ease, box-shadow .16s ease;
      }
      .pm-modal input:focus, .pm-modal textarea:focus, .pm-modal select:focus {
        border-color: var(--nomark-accent, #ff6060);
        box-shadow: 0 0 0 4px rgba(255,96,96,0.12);
      }
      .pm-modal textarea { min-height: 120px; resize: vertical; }
      .pm-help-text { margin: -8px 0 12px; font-size: 11px; color: var(--nomark-muted); line-height: 1.55; }
      .pm-modal select.pm-select-native { display: none; }
      .pm-select { position: relative; z-index: 2; margin-bottom: 13px; }
      .pm-select.pm-open { z-index: 30; }
      .pm-select-trigger {
        width: 100%; min-height: 42px; padding: 0 12px 0 13px;
        border: 1px solid var(--nomark-border); border-radius: 12px;
        background: linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,96,96,.025)), var(--nomark-soft);
        color: var(--nomark-ink); cursor: pointer;
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        transition: border-color .16s ease, box-shadow .16s ease, background .16s ease, transform .12s ease;
      }
      .pm-select-trigger:hover { border-color: rgba(255,96,96,.28); background: var(--nomark-card); }
      .pm-select.pm-open .pm-select-trigger {
        border-color: rgba(255,96,96,.56);
        background: var(--nomark-card);
        box-shadow: 0 0 0 4px rgba(255,96,96,.12), 0 8px 22px rgba(0,0,0,.08);
      }
      .pm-select-value {
        min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 13px; font-weight: 650;
      }
      .pm-select-arrow {
        width: 24px; height: 24px; border-radius: 999px;
        display: inline-flex; align-items: center; justify-content: center;
        color: var(--nomark-muted); background: rgba(255,96,96,.08);
        transition: transform .16s ease, color .16s ease, background .16s ease;
      }
      .pm-select.pm-open .pm-select-arrow {
        transform: rotate(180deg); color: var(--nomark-ink); background: rgba(255,96,96,.14);
      }
      .pm-select-menu {
        position: absolute; left: 0; right: 0; top: calc(100% + 7px);
        max-height: 188px; overflow: auto; padding: 6px;
        border: 1px solid var(--nomark-border); border-radius: 14px;
        background: var(--nomark-card);
        box-shadow: 0 18px 48px rgba(0,0,0,.18), 0 0 0 1px rgba(255,96,96,.04);
        opacity: 0; transform: translateY(-4px) scale(.985);
        pointer-events: none; transform-origin: top center;
        transition: opacity .14s ease, transform .16s cubic-bezier(.16,1,.3,1);
      }
      .pm-select.pm-open .pm-select-menu { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
      .pm-select-option {
        width: 100%; min-height: 34px; padding: 0 10px;
        border: 1px solid transparent; border-radius: 10px;
        background: transparent; color: var(--nomark-muted); cursor: pointer;
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        font-size: 13px; font-weight: 600; text-align: left;
      }
      .pm-select-option:hover, .pm-select-option:focus-visible {
        background: var(--nomark-soft); color: var(--nomark-ink); outline: none;
      }
      .pm-select-option.pm-selected {
        border-color: rgba(255,96,96,.22); background: rgba(255,96,96,.1); color: var(--nomark-ink);
      }
      .pm-select-check { color: var(--nomark-accent, #ff6060); font-size: 12px; opacity: 0; }
      .pm-select-option.pm-selected .pm-select-check { opacity: 1; }
      .pm-modal-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
      .pm-btn-cancel, .pm-btn-save {
        padding: 8px 20px; border-radius: 12px; border: 1px solid var(--nomark-border);
        cursor: pointer; font-size: 13px; font-weight: 600; transition: all .15s;
      }
      .pm-btn-cancel { background: var(--nomark-soft); color: var(--nomark-ink); }
      .pm-btn-cancel:hover { background: var(--nomark-border); }
      .pm-btn-save { background: var(--nomark-accent, #ff6060); color: #fff; border-color: var(--nomark-accent, #ff6060); }
      .pm-btn-save:hover { background: #e55555; }
      .pm-btn-danger {
        background: #ef4444; color: #fff; border: none; border-radius: 12px;
        padding: 8px 20px; font-size: 13px; font-weight: 600;
        cursor: pointer; transition: all .15s ease;
      }
      .pm-btn-danger:hover { background: #dc2626; transform: translateY(-1px); box-shadow: 0 5px 16px rgba(239,68,68,.25); }
      .pm-dialog-modal { max-width: 480px; }
      .pm-dialog-body { font-size: 13px; color: var(--nomark-muted); line-height: 1.7; margin-bottom: 16px; }
      .pm-dialog-input {
        width: 100%; box-sizing: border-box; border: 1px solid var(--nomark-border);
        border-radius: 12px; background-color: var(--nomark-soft); color: var(--nomark-ink);
        padding: 10px 12px; font-size: 13px; outline: none; margin-bottom: 16px;
        transition: border-color .16s ease, box-shadow .16s ease;
      }
      .pm-dialog-input:focus { border-color: rgba(255,96,96,.55); box-shadow: 0 0 0 4px rgba(255,96,96,.12); }
      .pm-conflict-modal { width: 520px; }
      .pm-conflict-desc { font-size: 13px; color: var(--nomark-muted); margin-bottom: 12px; }
      .pm-conflict-global { display: flex; gap: 8px; margin-bottom: 12px; }
      .pm-conflict-global-btn {
        padding: 6px 14px; border-radius: 12px; border: 1px solid var(--nomark-border);
        background: var(--nomark-card); cursor: pointer; font-size: 12px; font-weight: 600; transition: all .15s;
      }
      .pm-conflict-global-btn:hover { border-color: var(--nomark-accent, #ff6060); }
      .pm-conflict-global-btn.pm-conflict-active { background: var(--nomark-accent, #ff6060); color: #fff; border-color: var(--nomark-accent, #ff6060); }
      .pm-conflict-list { max-height: 300px; overflow-y: auto; }
      .pm-conflict-item { padding: 10px; border: 1px solid var(--nomark-border); border-radius: 12px; margin-bottom: 8px; }
      .pm-conflict-title { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
      .pm-conflict-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
      .pm-conflict-side { padding: 8px; border-radius: 8px; background: var(--nomark-soft); }
      .pm-conflict-side-header { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px; color: var(--nomark-muted); }
      .pm-conflict-newer { color: var(--nomark-accent, #ff6060); font-weight: 600; }
      .pm-conflict-side-content { font-size: 12px; max-height: 60px; overflow: hidden; text-overflow: ellipsis; }
      .pm-conflict-actions { display: flex; gap: 8px; }
      .pm-conflict-btn {
        padding: 4px 12px; border-radius: 8px; border: 1px solid var(--nomark-border);
        background: var(--nomark-card); cursor: pointer; font-size: 12px; font-weight: 600;
      }
      .pm-conflict-btn:hover { border-color: var(--nomark-accent, #ff6060); }
      .pm-conflict-btn.pm-conflict-active { background: var(--nomark-accent, #ff6060); color: #fff; border-color: var(--nomark-accent, #ff6060); }
      .pm-help-dialog {
        font-size: 13px; line-height: 1.8; color: var(--nomark-ink);
      }
      .pm-help-dialog code {
        padding: 1px 4px; border-radius: 5px;
        background: rgba(255,96,96,.08); color: var(--nomark-accent, #ff6060);
        font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      }
      @media (max-width: 760px) {
        #doubao-prompt-modal {
          left: 12px; right: 12px; bottom: 158px;
          width: auto; max-width: none; height: 72vh;
        }
      }
    `;
    modal.appendChild(style);
    modal.innerHTML += `
      <div class="pm-topbar">
        <h3>提示词库</h3>
        <span class="pm-topbar-spacer"></span>
        <button class="pm-topbar-btn" id="pm-btn-help" title="使用说明">?</button>
        <button class="pm-topbar-btn" id="pm-btn-close" title="关闭">✕ 关闭</button>
      </div>
      <div class="pm-search-bar">
        <input id="pm-search" type="text" placeholder="搜索提示词..." />
      </div>
      <div class="pm-categories" id="pm-categories"></div>
      <div class="pm-list" id="pm-list"></div>
      <div class="pm-add-bar">
        <button class="pm-add-btn" id="pm-btn-add" title="新增提示词"><span class="pm-btn-ico">➕</span><span class="pm-btn-label">新增提示词</span></button>
        <button class="pm-export-btn" id="pm-btn-import" title="导入 JSON"><span class="pm-btn-ico">📥</span><span class="pm-btn-label">导入</span></button>
        <button class="pm-export-btn" id="pm-btn-export" title="导出 JSON"><span class="pm-btn-ico">📤</span><span class="pm-btn-label">导出</span></button>
        <input type="file" id="pm-file-input" accept=".json" style="display:none" />
      </div>
    `;
    document.body.appendChild(modal);
    promptModalElement = modal;
    document.getElementById('pm-btn-help').addEventListener('click', () => showPromptHelpDialog());
    document.getElementById('pm-btn-close').addEventListener('click', closePromptModal);
    document.getElementById('pm-btn-add').addEventListener('click', () => LibraryUI.showEditModal());
    document.getElementById('pm-btn-import').addEventListener('click', () => document.getElementById('pm-file-input').click());
    document.getElementById('pm-btn-export').addEventListener('click', () => { StorageService.exportJSON(LibraryUI._prompts); showToast('已导出提示词数据'); });
    document.getElementById('pm-file-input').addEventListener('change', e => LibraryUI._handleImport(e));
    document.getElementById('pm-search').addEventListener('input', e => { LibraryUI._searchKeyword = e.target.value; LibraryUI.renderList(); });
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') closePromptModal(); });
  }
  const NOMARK_BUTTON_HOST_ID = "doubao-nomark-button-host";
  const NOMARK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7"><rect x="3.5" y="5" width="17" height="14" rx="3"/><circle cx="8.2" cy="9.2" r="1.25"/><path d="m5.8 16 4.15-4.15a1.35 1.35 0 0 1 1.9 0L14 14l1.15-1.15a1.35 1.35 0 0 1 1.9 0L18.7 14.5"/></g></svg>`;

  let floatingBtnElement = null;
  let modalElement = null;
  // 下载模式：右键菜单和模态框共用此状态
  // "overlay"：重叠去水印（合并 previewImage + downloadImage）
  // "direct"：API 直链（直接下载 image_ori_raw，无水印原图）
  // 直链模式下若图片无 directUrl，自动回退到重叠合并
  let downloadMode = "direct";
  let imageFilter = "all"; // "all" | "ai" | "user"
  let sortOrder = "desc"; // "desc" = 最新在前, "asc" = 最早在前
  let uiKeydownBound = false;

  function compareDisplayItemsByTime(a, b) {
    const timeA = Number(a.item.createTime) || 0;
    const timeB = Number(b.item.createTime) || 0;
    if (timeA && timeB && timeA !== timeB) {
      return sortOrder === "desc" ? timeB - timeA : timeA - timeB;
    }
    if (timeA && !timeB) return -1;
    if (!timeA && timeB) return 1;
    if (a.item.messageId && a.item.messageId === b.item.messageId) {
      const imageIndexA = a.item.messageImageIndex;
      const imageIndexB = b.item.messageImageIndex;
      if (imageIndexA != null && imageIndexB != null && imageIndexA !== imageIndexB) {
        return imageIndexA - imageIndexB;
      }
    }
    const seqA = Number.isFinite(Number(a.item.sequence)) ? Number(a.item.sequence) : a.index;
    const seqB = Number.isFinite(Number(b.item.sequence)) ? Number(b.item.sequence) : b.index;
    return sortOrder === "desc" ? seqB - seqA : seqA - seqB;
  }

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
    const conversationId = getConversationId();
    let total = 0, ai = 0, user = 0, direct = 0, locatable = 0;
    for (const item of collectedImages) {
      if (conversationId && item.conversationId !== conversationId) continue;
      total++;
      if (item.source === "ai") ai++;
      else if (item.source === "user") user++;
      if (item.directUrl) direct++;
      if (item.element || item.messageId) locatable++;
    }
    return { total, ai, user, direct, locatable };
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
      const aiEl = modalElement.querySelector(".nomark-stat-ai");
      const userEl = modalElement.querySelector(".nomark-stat-user");
      const directEl = modalElement.querySelector(".nomark-stat-direct");
      const locateEl = modalElement.querySelector(".nomark-stat-locate");
      if (totalEl) totalEl.textContent = String(stats.total);
      if (aiEl) aiEl.textContent = String(stats.ai);
      if (userEl) userEl.textContent = String(stats.user);
      if (directEl) directEl.textContent = String(stats.direct);
      if (locateEl) locateEl.textContent = String(stats.locatable);
      updateSelectedCount();
    }
  }

  function updateSelectedCount() {
    if (!modalElement) return;
    const selectedCount = getSelectedDisplayIndices().length;
    const selectedEl = modalElement.querySelector(".nomark-selected-count");
    const batchBtn = modalElement.querySelector(".btn-batch-download");
    if (selectedEl) selectedEl.textContent = String(selectedCount);
    if (batchBtn && !batchBtn.dataset.busy) {
      batchBtn.textContent = selectedCount > 0 ? `批量下载 ${selectedCount}` : "批量下载";
    }
  }

  function setCardSelected(checkbox) {
    const idx = parseInt(checkbox.dataset.recordIndex, 10);
    if (checkbox.checked) selectedIndices.add(idx);
    else selectedIndices.delete(idx);
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
    floatingBtnElement.addEventListener("click", () => {
      if (modalElement && modalElement.classList.contains("show")) closeModal();
      else openModal();
    });
    updateModalCount();
  }

  function openModal() {
    // 关闭提示词库面板
    if (promptModalElement && promptModalElement.classList.contains("show")) {
      closePromptModal();
    }
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
        .nomark-filter-toggle {
          display: inline-flex;
          align-items: center;
          padding: 3px;
          border: 1px solid var(--nomark-border);
          border-radius: 999px;
          background: rgba(246, 247, 249, .88);
          gap: 2px;
        }
        .nomark-filter-btn {
          min-height: 26px;
          padding: 0 10px;
          border: none;
          border-radius: 999px;
          background: transparent;
          color: var(--nomark-muted);
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
          transition: background .16s ease, color .16s ease;
        }
        .nomark-filter-btn:hover:not(.active) { background: #fff; color: var(--nomark-ink); }
        .nomark-filter-btn.active {
          background: #374151;
          color: #fff;
        }
        .nomark-sort-btn {
          min-height: 26px;
          padding: 0 10px;
          border: none;
          border-radius: 999px;
          background: transparent;
          color: var(--nomark-muted);
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
          transition: background .16s ease, color .16s ease;
        }
        .nomark-sort-btn:hover:not(.active) { background: #fff; color: var(--nomark-ink); }
        .nomark-sort-btn.active {
          background: #374151;
          color: #fff;
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
              <span class="nomark-stat-card">AI <strong class="nomark-stat-ai">0</strong></span>
              <span class="nomark-stat-card">用户 <strong class="nomark-stat-user">0</strong></span>
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
            <button class="nomark-top-btn btn-full-scan" type="button" title="自动滚动对话加载所有历史图片">全量扫描</button>
            <div class="nomark-filter-toggle" style="margin-left:8px;">
              <button class="nomark-filter-btn active" data-filter="all" type="button">全部</button>
              <button class="nomark-filter-btn" data-filter="ai" type="button">AI 生成</button>
              <button class="nomark-filter-btn" data-filter="user" type="button">用户上传</button>
            </div>
            <div class="nomark-filter-toggle" style="margin-left:8px;">
              <button class="nomark-sort-btn active" data-sort="desc" type="button" title="最新在前">↓ 最新</button>
              <button class="nomark-sort-btn" data-sort="asc" type="button" title="最早在前">↑ 最早</button>
            </div>
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

    container.addEventListener("change", (e) => {
      if (e.target.classList.contains("nomark-select")) setCardSelected(e.target);
    });
    container.addEventListener("click", async (e) => {
      const btn = e.target.closest(".nomark-download-btn");
      if (btn) {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.recordIndex, 10);
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
        return;
      }
      const locateBtn = e.target.closest(".btn-locate");
      if (locateBtn) {
        e.stopPropagation();
        const idx = parseInt(locateBtn.dataset.recordIndex, 10);
        const item = collectedImages[idx];
        if (!item) return;
        closeModal();
        setTimeout(() => {
          const scrolled = item.messageId && scrollToMessage(item.messageId);
          const waitMs = scrolled ? 800 : 300;
          setTimeout(() => {
            const target = findElementByMessageIndex(item.messageId, item.messageImageIndex)
              || findElementByInfo(item.info, item.messageId)
              || findVisibleChatElementByInfo(item.info)
              || (isElementUsableForItem(item.element, item) ? item.element : null)
              || (item.messageId ? null : findElementByInfo(item.info));
            if (target) {
              item.element = target;
              target.scrollIntoView({ behavior: "smooth", block: "center" });
              const orig = target.style.outline;
              const origOffset = target.style.outlineOffset;
              target.style.outline = "3px solid #ff6060";
              target.style.outlineOffset = "3px";
              setTimeout(() => {
                target.style.outline = orig;
                target.style.outlineOffset = origOffset;
              }, 2000);
            } else {
              showToast("图片当前未在页面中渲染", 3000);
            }
          }, waitMs);
        }, 200);
        return;
      }
      const preview = e.target.closest(".nomark-preview");
      if (preview) {
        const cb = preview.closest(".nomark-card")?.querySelector(".nomark-select");
        if (cb) {
          cb.checked = !cb.checked;
          setCardSelected(cb);
        }
      }
    });

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

    // 全量扫描：自动滚动对话触发懒加载
    const fullScanBtn = modal.querySelector(".btn-full-scan");
    if (fullScanBtn) {
      fullScanBtn.addEventListener("click", async () => {
        fullScanBtn.disabled = true;
        fullScanBtn.textContent = "扫描中…";
        showToast("正在扫描历史图片，请稍候…", 0);
        try {
          await fullScanConversation();
          renderModalImages();
          showToast(`扫描完成，共 ${getCurrentCollectedImages().length} 张图片`);
        } catch (err) {
          showToast(`扫描失败：${err.message}`, 3000);
        }
        fullScanBtn.disabled = false;
        fullScanBtn.textContent = "全量扫描";
      });
    }

    // 图片筛选切换
    modal.querySelectorAll(".nomark-filter-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        imageFilter = btn.dataset.filter;
        modal.querySelectorAll(".nomark-filter-btn").forEach(b => b.classList.toggle("active", b.dataset.filter === imageFilter));
        renderModalImages();
      });
    });

    // 排序切换
    modal.querySelectorAll(".nomark-sort-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        sortOrder = btn.dataset.sort;
        modal.querySelectorAll(".nomark-sort-btn").forEach(b => b.classList.toggle("active", b.dataset.sort === sortOrder));
        renderModalImages();
      });
    });

    selectAllBtn.addEventListener("click", () => {
      collectedImages.forEach((item, idx) => {
        if (isCurrentDisplayItem(item)) {
          selectedIndices.add(idx);
        }
      });
      renderModalImages();
    });

    clearBtn.addEventListener("click", () => {
      selectedIndices.clear();
      renderModalImages();
    });

    let batchDownloading = false;
    let batchCancel = false;

    batchBtn.addEventListener("click", async () => {
      if (batchDownloading) { batchCancel = true; return; }

      const selected = getSelectedDisplayIndices();
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
      const doneIndices = new Set();
      batchProgress = { status: "downloading", selectedIndices: new Set(selected), total, currentNum: 0, currentIndex: -1, successCount: 0, doneIndices, isDirect: false };
      renderModalImages();

      for (let i = 0; i < selected.length; i++) {
        if (batchCancel) break;
        const idx = selected[i];
        const item = collectedImages[idx];
        if (!item) continue;

        batchProgress.currentIndex = idx;
        batchProgress.currentNum = i + 1;
        renderModalImages();

        try {
          const isDirect = downloadMode === "direct" && item.directUrl;
          batchProgress.isDirect = isDirect;
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
          batchProgress.successCount = successCount;
          doneIndices.add(idx);
          renderModalImages();
        } catch (err) {
          doneIndices.add(idx);
          renderModalImages();
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
      batchProgress = createEmptyBatchProgress();
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
    return Promise.race([
      mergeImages(blobA, blobB),
      new Promise((_, reject) => setTimeout(() => reject(new Error("图片合并超时(30s)")), MERGE_TIMEOUT_MS)),
    ]);
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

    const currentConversationId = getConversationId();
    const currentItems = collectedImages
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !currentConversationId || item.conversationId === currentConversationId);

    console.log(`[无水印] renderModalImages: currentImages=${currentItems.length}, imageFilter=${imageFilter}`);
    if (currentItems.length > 0) {
      const sources = currentItems.reduce((acc, { item }) => { acc[item.source] = (acc[item.source] || 0) + 1; return acc; }, {});
      const withTime = currentItems.filter(({ item }) => item.createTime > 0).length;
      console.log(`[无水印] 图片来源分布:`, sources, `有时间戳: ${withTime}`);
    }

    // 筛选 + 按时间排序（最新在前）
    const displayItems = currentItems
      .filter(({ item }) => imageFilter === "all" || item.source === imageFilter)
      .sort(compareDisplayItemsByTime);

    console.log(`[无水印] 筛选后显示 ${displayItems.length} 张图片`);

    if (displayItems.length === 0) {
      const filterTip = imageFilter === "ai" ? "AI 生成的图片" : imageFilter === "user" ? "用户上传的图片" : "图片";
      container.innerHTML = `
        <div class="nomark-empty">
          <div>
            <div class="nomark-empty-icon">🖼️</div>
            <div class="nomark-empty-text">暂未发现${filterTip}</div>
            <div class="nomark-empty-sub">请先在豆包页面生成或打开图片。插件会自动扫描当前页面，也可以在图片或右侧 canvas 大图上右键触发捕获。</div>
          </div>
        </div>
      `;
      updateSelectedCount();
      return;
    }

    container.innerHTML = displayItems.map(({ item, index }, displayIndex) => {
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
      const alt = `图片 ${displayIndex + 1}`;
      const isSelected = selectedIndices.has(index);
      const selectedClass = isSelected ? " selected" : "";
      const checkedAttr = isSelected ? " checked" : "";
      let dlText = "下载";
      let dlClass = "nomark-action-btn nomark-download-btn";
      if (batchProgress.status && batchProgress.selectedIndices?.has(index)) {
        if (batchProgress.doneIndices?.has(index)) {
          dlText = `✓ ${batchProgress.successCount}/${batchProgress.total}`;
          dlClass += " success";
        } else if (batchProgress.currentIndex === index) {
          dlText = `${batchProgress.isDirect ? "下载中" : "合并中"} ${batchProgress.currentNum}/${batchProgress.total}`;
        }
      }
      return `
        <div class="nomark-card${selectedClass}" data-record-index="${index}">
          <div class="nomark-preview" title="点击选择图片">
            <img src="${escapeHtml(item.thumbnailUrl)}" alt="${escapeHtml(alt)}" loading="lazy">
            <span class="nomark-card-badge">${escapeHtml(badge)}</span>
            <span class="nomark-info">${escapeHtml(resolution)}</span>
            <div class="nomark-preview-tip"><span>${escapeHtml(modeTip)}</span></div>
          </div>
          <div class="nomark-actions">
            <button class="${dlClass}" data-record-index="${index}">${escapeHtml(dlText)}</button>
            <button class="nomark-action-btn btn-locate" data-record-index="${index}" ${hasElement ? "" : "disabled"}>定位</button>
            <label class="nomark-select-wrap" title="选择图片 ${displayIndex + 1}">
              <input class="nomark-select" type="checkbox" data-record-index="${index}"${checkedAttr} aria-label="选择图片 ${displayIndex + 1}">
            </label>
          </div>
        </div>
      `;
    }).join("");

    updateSelectedCount();
  }

  console.log("[无水印] 所有函数已定义，准备初始化 UI");
  createFloatingButton();
  createPromptFloatingButton();
  LibraryUI.init().then(() => console.log("[无水印] 提示词库初始化完成")).catch(e => console.log("[无水印] 提示词库初始化失败:", e));
  GM_registerMenuCommand('打开提示词库', () => openPromptModal());
  GM_registerMenuCommand('导出提示词备份', () => { StorageService.exportJSON(LibraryUI._prompts); showToast('已导出'); });
  console.log("[无水印] 脚本初始化完成");
})();
