# Local Qwen Translation Extension MVP

下面是一套**最小可用**的 Chromium 浏览器插件代码，支持：
- 右上角图标弹窗手动翻译
- 右键菜单翻译选中文本
- 右键菜单翻译当前页面非中文文本
- 默认目标语言类型设置
- 自动识别中文 / 非中文，并按规则路由
- 调用本地 Qwen3.5-9B 的 OpenAI-compatible HTTP 接口

> 约定：本地模型服务地址默认使用 `http://localhost:8000/v1`，模型名通过设置页配置。
> 如果你用的是 vLLM / SGLang / 其他兼容服务，只要返回 OpenAI 风格的 `/chat/completions` 即可。

---

## 目录结构

```text
local-qwen-translation-extension/
├─ manifest.json
├─ service_worker.js
├─ content_script.js
├─ popup.html
├─ popup.js
├─ options.html
├─ options.js
├─ styles.css
└─ icons/
   ├─ icon16.png
   ├─ icon48.png
   └─ icon128.png
```

图标文件你可以先随便放三张同名 PNG 占位图。

---

## 1) manifest.json

```json
{
  "manifest_version": 3,
  "name": "Local Qwen Translator",
  "version": "0.1.0",
  "description": "Translate web pages and selected text with a local Qwen model.",
  "permissions": ["storage", "contextMenus", "activeTab", "scripting"],
  "host_permissions": ["http://localhost:8000/*", "http://127.0.0.1:8000/*"],
  "action": {
    "default_title": "Local Qwen Translator",
    "default_popup": "popup.html"
  },
  "background": {
    "service_worker": "service_worker.js"
  },
  "options_page": "options.html",
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content_script.js"],
      "run_at": "document_idle"
    }
  ]
}
```

---

## 2) service_worker.js

```javascript
const DEFAULT_SETTINGS = {
  apiBaseUrl: "http://localhost:8000/v1",
  modelName: "qwen3.5-9b",
  defaultTargetLanguage: "English",
  autoTranslatePage: true,
  pageTranslateTargetForChinese: "English",
  pageTranslateTargetForNonChinese: "Chinese",
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...current });

  chrome.contextMenus.create({
    id: "translate-selection",
    title: "翻译选中的文本",
    contexts: ["selection"],
  });

  chrome.contextMenus.create({
    id: "translate-page",
    title: "翻译当前页面",
    contexts: ["page"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === "translate-selection") {
    chrome.tabs.sendMessage(tab.id, {
      type: "TRANSLATE_SELECTION",
      text: info.selectionText || "",
    });
    return;
  }

  if (info.menuItemId === "translate-page") {
    chrome.tabs.sendMessage(tab.id, {
      type: "TRANSLATE_PAGE",
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "TRANSLATE_TEXT") return;

  (async () => {
    try {
      const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      const result = await translateText({
        text: message.text,
        settings,
      });
      sendResponse({ ok: true, ...result });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});

function isChineseText(text) {
  const cleaned = (text || "").trim();
  if (!cleaned) return false;

  const chineseChars = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (cleaned.match(/[A-Za-z\u00C0-\u024F\u0400-\u04FF\u3040-\u30FF\uAC00-]/g) || []).length;

  // 中文占明显多数时，视为中文。
  if (chineseChars >= Math.max(2, letters)) return true;
  return false;
}

async function translateText({ text, settings }) {
  const sourceIsChinese = isChineseText(text);
  const targetLanguage = sourceIsChinese
    ? settings.pageTranslateTargetForChinese || settings.defaultTargetLanguage || "English"
    : settings.pageTranslateTargetForNonChinese || "Chinese";

  const apiBaseUrl = settings.apiBaseUrl.replace(/\/$/, "");
  const modelName = settings.modelName;

  const systemPrompt = [
    "You are a professional translation engine.",
    "Translate faithfully and naturally.",
    "Output only the translated text.",
    "Preserve meaning, tone, punctuation, HTML tags, placeholders, and code blocks.",
    `Translate the input into ${targetLanguage}.`,
  ].join(" ");

  const body = {
    model: modelName,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    temperature: 0.1,
    top_p: 0.9,
    stream: false,
  };

  const resp = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const raw = await resp.text();
    throw new Error(`模型接口错误 ${resp.status}: ${raw}`);
  }

  const data = await resp.json();
  const translated = data?.choices?.[0]?.message?.content?.trim();
  if (!translated) {
    throw new Error("模型返回为空");
  }

  return {
    translated,
    sourceIsChinese,
    targetLanguage,
  };
}
```

---

## 3) content_script.js

```javascript
function sendTranslateRequest(text) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "TRANSLATE_TEXT", text },
      (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "翻译失败"));
          return;
        }
        resolve(response);
      }
    );
  });
}

function isTranslatableNode(node) {
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  if (!node.nodeValue || !node.nodeValue.trim()) return false;

  const parent = node.parentElement;
  if (!parent) return false;

  const tag = parent.tagName?.toLowerCase();
  if (["script", "style", "noscript", "textarea", "input", "option"].includes(tag)) {
    return false;
  }

  return true;
}

function walkTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let current;
  while ((current = walker.nextNode())) {
    if (isTranslatableNode(current)) nodes.push(current);
  }
  return nodes;
}

function isChineseText(text) {
  const cleaned = (text || "").trim();
  if (!cleaned) return false;
  const chineseChars = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (cleaned.match(/[A-Za-z\u00C0-\u024F\u0400-\u04FF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
  return chineseChars >= Math.max(2, letters);
}

async function translateAndReplaceTextNode(textNode) {
  const original = textNode.nodeValue;
  if (!original || !original.trim()) return;

  // 跳过很短的碎片，减少误翻译
  if (original.trim().length < 2) return;

  try {
    const result = await sendTranslateRequest(original);
    textNode.nodeValue = result.translated;
  } catch (err) {
    console.warn("翻译失败：", err);
  }
}

async function translateSelection(text) {
  if (!text || !text.trim()) return;
  const translated = await sendTranslateRequest(text);
  alert(translated.translated);
}

async function translatePage() {
  const nodes = walkTextNodes(document.body);

  // 简单串行，最稳；如果你后面想提速，可以改成并发池。
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!text || !text.trim()) continue;

    // 只翻译非中文文本；中文页面默认可保留不动。
    if (isChineseText(text)) continue;

    await translateAndReplaceTextNode(node);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "TRANSLATE_SELECTION") {
    translateSelection(message.text || "");
  }

  if (message?.type === "TRANSLATE_PAGE") {
    translatePage();
  }
});
```

---

## 4) popup.html

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Local Qwen Translator</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body class="popup-body">
    <div class="panel">
      <h1>本地翻译</h1>

      <label>待翻译文本</label>
      <textarea id="inputText" placeholder="粘贴需要翻译的文本"></textarea>

      <div class="row">
        <button id="translateBtn">翻译</button>
        <button id="copyBtn" type="button">复制结果</button>
      </div>

      <label>结果</label>
      <textarea id="outputText" readonly placeholder="翻译结果会显示在这里"></textarea>

      <div class="meta">
        <span id="metaInfo">自动识别：中文→英文，非中文→中文</span>
      </div>
    </div>
    <script src="popup.js"></script>
  </body>
</html>
```

---

## 5) popup.js

```javascript
const inputText = document.getElementById("inputText");
const outputText = document.getElementById("outputText");
const translateBtn = document.getElementById("translateBtn");
const copyBtn = document.getElementById("copyBtn");

function isChineseText(text) {
  const cleaned = (text || "").trim();
  if (!cleaned) return false;
  const chineseChars = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (cleaned.match(/[A-Za-z\u00C0-\u024F\u0400-\u04FF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
  return chineseChars >= Math.max(2, letters);
}

async function translateText(text) {
  const settings = await chrome.storage.sync.get({
    apiBaseUrl: "http://localhost:8000/v1",
    modelName: "qwen3.5-9b",
    defaultTargetLanguage: "English",
    pageTranslateTargetForChinese: "English",
    pageTranslateTargetForNonChinese: "Chinese",
  });

  const sourceIsChinese = isChineseText(text);
  const targetLanguage = sourceIsChinese
    ? settings.pageTranslateTargetForChinese || settings.defaultTargetLanguage || "English"
    : settings.pageTranslateTargetForNonChinese || "Chinese";

  const prompt = [
    "You are a professional translation engine.",
    "Translate faithfully and naturally.",
    "Output only the translated text.",
    `Translate the input into ${targetLanguage}.`,
  ].join(" ");

  const resp = await fetch(`${settings.apiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.modelName,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: text },
      ],
      temperature: 0.1,
      stream: false,
    }),
  });

  if (!resp.ok) {
    throw new Error(await resp.text());
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

translateBtn.addEventListener("click", async () => {
  const text = inputText.value.trim();
  if (!text) {
    outputText.value = "";
    return;
  }

  translateBtn.disabled = true;
  translateBtn.textContent = "翻译中...";

  try {
    const result = await translateText(text);
    outputText.value = result;
  } catch (err) {
    outputText.value = `错误：${err.message}`;
  } finally {
    translateBtn.disabled = false;
    translateBtn.textContent = "翻译";
  }
});

copyBtn.addEventListener("click", async () => {
  const text = outputText.value || "";
  if (!text) return;
  await navigator.clipboard.writeText(text);
  copyBtn.textContent = "已复制";
  setTimeout(() => (copyBtn.textContent = "复制结果"), 1200);
});
```

---

## 6) options.html

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>设置</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body class="options-body">
    <div class="panel options-panel">
      <h1>插件设置</h1>

      <label for="apiBaseUrl">本地模型 API Base URL</label>
      <input id="apiBaseUrl" type="text" placeholder="http://localhost:8000/v1" />

      <label for="modelName">模型名</label>
      <input id="modelName" type="text" placeholder="qwen3.5-9b" />

      <label for="defaultTargetLanguage">默认目标语言类型</label>
      <select id="defaultTargetLanguage">
        <option value="English">English</option>
        <option value="Chinese">中文</option>
        <option value="French">Français</option>
        <option value="German">Deutsch</option>
        <option value="Japanese">日本語</option>
        <option value="Korean">한국어</option>
        <option value="Russian">Русский</option>
      </select>

      <label for="pageTranslateTargetForChinese">检测到中文时翻译成</label>
      <select id="pageTranslateTargetForChinese">
        <option value="English">English</option>
        <option value="Chinese">中文</option>
        <option value="French">Français</option>
        <option value="German">Deutsch</option>
        <option value="Japanese">日本語</option>
        <option value="Korean">한국어</option>
        <option value="Russian">Русский</option>
      </select>

      <label for="pageTranslateTargetForNonChinese">检测到非中文时翻译成</label>
      <select id="pageTranslateTargetForNonChinese">
        <option value="Chinese">中文</option>
        <option value="English">English</option>
        <option value="French">Français</option>
        <option value="German">Deutsch</option>
        <option value="Japanese">日本語</option>
        <option value="Korean">한국어</option>
        <option value="Russian">Русский</option>
      </select>

      <div class="row">
        <button id="saveBtn">保存</button>
        <span id="status"></span>
      </div>
    </div>
    <script src="options.js"></script>
  </body>
</html>
```

---

## 7) options.js

```javascript
const fields = {
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  modelName: document.getElementById("modelName"),
  defaultTargetLanguage: document.getElementById("defaultTargetLanguage"),
  pageTranslateTargetForChinese: document.getElementById("pageTranslateTargetForChinese"),
  pageTranslateTargetForNonChinese: document.getElementById("pageTranslateTargetForNonChinese"),
};

const saveBtn = document.getElementById("saveBtn");
const status = document.getElementById("status");

async function loadSettings() {
  const data = await chrome.storage.sync.get({
    apiBaseUrl: "http://localhost:8000/v1",
    modelName: "qwen3.5-9b",
    defaultTargetLanguage: "English",
    pageTranslateTargetForChinese: "English",
    pageTranslateTargetForNonChinese: "Chinese",
  });

  fields.apiBaseUrl.value = data.apiBaseUrl;
  fields.modelName.value = data.modelName;
  fields.defaultTargetLanguage.value = data.defaultTargetLanguage;
  fields.pageTranslateTargetForChinese.value = data.pageTranslateTargetForChinese;
  fields.pageTranslateTargetForNonChinese.value = data.pageTranslateTargetForNonChinese;
}

async function saveSettings() {
  await chrome.storage.sync.set({
    apiBaseUrl: fields.apiBaseUrl.value.trim(),
    modelName: fields.modelName.value.trim(),
    defaultTargetLanguage: fields.defaultTargetLanguage.value,
    pageTranslateTargetForChinese: fields.pageTranslateTargetForChinese.value,
    pageTranslateTargetForNonChinese: fields.pageTranslateTargetForNonChinese.value,
  });

  status.textContent = "已保存";
  setTimeout(() => (status.textContent = ""), 1200);
}

saveBtn.addEventListener("click", saveSettings);
loadSettings();
```

---

## 8) styles.css

```css
body {
  font-family: Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  margin: 0;
  padding: 0;
  background: #f5f6f7;
  color: #222;
}

.popup-body {
  width: 360px;
}

.options-body {
  max-width: 640px;
  margin: 0 auto;
}

.panel {
  padding: 16px;
}

h1 {
  font-size: 18px;
  margin: 0 0 12px;
}

label {
  display: block;
  font-size: 13px;
  margin: 12px 0 6px;
}

textarea,
input,
select {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #ccc;
  border-radius: 8px;
  padding: 10px;
  font-size: 14px;
  background: white;
}

textarea {
  min-height: 120px;
  resize: vertical;
}

.row {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  align-items: center;
}

button {
  border: none;
  border-radius: 8px;
  padding: 10px 14px;
  background: #1f6feb;
  color: white;
  cursor: pointer;
}

button:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.meta {
  margin-top: 8px;
  font-size: 12px;
  color: #666;
}

#status {
  font-size: 13px;
  color: #0a7a0a;
}

.options-panel {
  padding-top: 24px;
}
```

---

## 9) 本地模型服务示例

如果你本地是 **vLLM**，Qwen 官方文档说明它可以直接启动 OpenAI-compatible API，默认在 `http://localhost:8000`。([qwen.readthedocs.io](https://qwen.readthedocs.io/en/latest/deployment/vllm.html?utm_source=chatgpt.com))

示例：

```bash
vllm serve Qwen/Qwen3.5-9B --host 127.0.0.1 --port 8000
```

如果你是 **SGLang**，Qwen 官方文档同样说明它可以提供 OpenAI-compatible API，默认端口示例为 `30000`。([qwen.readthedocs.io](https://qwen.readthedocs.io/en/latest/deployment/sglang.html?utm_source=chatgpt.com))

示例：

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3.5-9B --host 127.0.0.1 --port 8000
```

> 你的服务只要支持 `POST /v1/chat/completions`，返回 OpenAI 风格的 `choices[0].message.content`，这份插件代码就能直接调用。

---

## 10) 使用步骤

1. 把这些文件放进一个文件夹。
2. 准备图标文件，或者先用任意 PNG 占位。
3. Chrome 打开 `chrome://extensions/`。
4. 开启右上角“开发者模式”。
5. 点击“加载已解压的扩展程序”，选择这个文件夹。
6. 打开设置页，填入你的本地模型地址和模型名。
7. 直接测试：
   - 点插件图标，粘贴文本翻译
   - 选中文本，右键翻译
   - 在页面空白处右键，翻译当前页面

---

## 11) 这版的限制

这版是最小可用，所以有几个已知简化：
- 整页翻译是对文本节点逐个替换，复杂页面、虚拟列表、shadow DOM、iframe 可能不完整。
- 没做术语表和翻译记忆。
- 没做分段批量翻译，所以长页面会比较慢。
- 没有流式输出。
- 没有错误重试和速率控制。

---

如果你要，我下一步可以继续给你补一版：**整页翻译更稳的增强版**，会加入批处理、并发控制、原文/译文悬浮切换和更好的 DOM 保护策略。

