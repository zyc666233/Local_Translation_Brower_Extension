const inputText = document.getElementById("inputText");
const outputText = document.getElementById("outputText");
const translateBtn = document.getElementById("translateBtn");
const copyBtn = document.getElementById("copyBtn");
const sourceLang = document.getElementById("sourceLang");
const targetLang = document.getElementById("targetLang");
const metaInfo = document.getElementById("metaInfo");
const settingsIconBtn = document.getElementById("settingsIconBtn");

const DEFAULT_SETTINGS = {
  apiBaseUrl: "http://localhost:1234",
  chatPath: "/v1/chat/completions",
  modelName: "hy-mt2-1.8b",
  apiKey: "",
  apiKeyHeader: "Authorization",
  apiKeyPrefix: "Bearer",
  temperature: 0.7,
  topK: 20,
  topP: 0.6,
  maxTokens: 4096,
  timeoutMs: 120000,
  extraHeaders: "{}",
  defaultTargetLanguage: "Chinese",
};

const LANGS = [
  { value: "auto", label: "自动检测" },
  { value: "Chinese", label: "中文" },
  { value: "English", label: "English" },
  { value: "French", label: "Français" },
  { value: "German", label: "Deutsch" },
  { value: "Japanese", label: "日本語" },
  { value: "Korean", label: "한국어" },
  { value: "Russian", label: "Русский" },
];

function langLabel(value) {
  const found = LANGS.find((l) => l.value === value);
  return found ? found.label : value;
}

function previewText(text) {
  return String(text ?? "").replace(/\s+/g, " ").slice(0, 120);
}

function toNumberValue(value, fallback) {
  const raw = String(value ?? "").trim();
  if (raw === "") return fallback;

  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value, fallback) {
  const n = toNumberValue(value, fallback);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function buildRequestUrl(settings) {
  const base = String(settings.apiBaseUrl || "").trim().replace(/\/$/, "");
  const path = String(settings.chatPath || "").trim().startsWith("/")
    ? String(settings.chatPath || "").trim()
    : `/${String(settings.chatPath || "").trim()}`;

  return `${base}${path}`;
}

function buildRequestHeaders(settings) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (settings.apiKey) {
    headers[settings.apiKeyHeader || "Authorization"] = settings.apiKeyPrefix
      ? `${settings.apiKeyPrefix} ${settings.apiKey}`
      : settings.apiKey;
  }

  try {
    const extraHeaders = JSON.parse(settings.extraHeaders || "{}");
    if (extraHeaders && typeof extraHeaders === "object" && !Array.isArray(extraHeaders)) {
      Object.assign(headers, extraHeaders);
    }
  } catch {
    // 忽略非法 JSON，测试/翻译时由保存页校验
  }

  return headers;
}

function buildChatBody(settings, text, targetLabel) {
  const temperature = clamp01(settings.temperature, DEFAULT_SETTINGS.temperature);
  const topP = clamp01(settings.topP, DEFAULT_SETTINGS.topP);
  const topK = toNumberValue(settings.topK, DEFAULT_SETTINGS.topK);
  const maxTokens = Math.max(1, toNumberValue(settings.maxTokens, DEFAULT_SETTINGS.maxTokens));

  const prompt = [
    "You are a professional translation engine.",
    `Translate the following text into ${targetLabel}.`,
    "Translate faithfully and naturally. Preserve meaning, tone, punctuation, formatting, HTML tags, and placeholders.",
    "Output ONLY the translated text, no extra commentary.",
  ].join("\n");

  return {
    model: settings.modelName,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: text },
    ],
    temperature,
    top_k: topK,
    top_p: topP,
    max_tokens: maxTokens,
    stream: false,
    // 关闭思考模式，兼容多种 OpenAI-like 实现
    reasoning: {
      enabled: false,
    },
    thinking: {
      type: "disabled"
    },
    enable_thinking: false,
  };
}

function populateLangSelects(defaultTarget) {
  sourceLang.innerHTML = "";
  targetLang.innerHTML = "";

  const autoOpt = document.createElement("option");
  autoOpt.value = "auto";
  autoOpt.textContent = "自动检测";
  sourceLang.appendChild(autoOpt);

  for (const l of LANGS) {
    if (l.value !== "auto") {
      const opt = document.createElement("option");
      opt.value = l.value;
      opt.textContent = l.label;
      targetLang.appendChild(opt);
    }
  }

  sourceLang.value = "auto";
  targetLang.value = defaultTarget || "Chinese";
}

async function loadSettings() {
  return await chrome.storage.sync.get(DEFAULT_SETTINGS);
}

async function translateText(text, tgtLang) {
  const settings = await loadSettings();

  const detectedLang = LangDetect.detect(text);
  const tgtLabel = langLabel(tgtLang);

  if (detectedLang && detectedLang === tgtLang) {
    return {
      detectedLang: LangDetect.getNativeName(detectedLang),
      translatedText: text,
      sameLanguage: true,
    };
  }

  const controller = new AbortController();
  const timeoutMs = toNumberValue(settings.timeoutMs, DEFAULT_SETTINGS.timeoutMs);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(buildRequestUrl(settings), {
      method: "POST",
      headers: buildRequestHeaders(settings),
      signal: controller.signal,
      body: JSON.stringify(buildChatBody(settings, text, tgtLabel)),
    });

    if (!resp.ok) {
      throw new Error(await resp.text());
    }

    const data = await resp.json();
    const translated = data?.choices?.[0]?.message?.content?.trim() || text;

    return {
      detectedLang: detectedLang ? LangDetect.getNativeName(detectedLang) : "",
      translatedText: translated,
      sameLanguage: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function init() {
  const settings = await loadSettings();
  populateLangSelects(settings.defaultTargetLanguage);
}

init();

translateBtn.addEventListener("click", async () => {
  const text = inputText.value.trim();
  if (!text) {
    outputText.value = "";
    metaInfo.textContent = "自动识别待翻译文本语言类型";
    return;
  }

  translateBtn.disabled = true;
  translateBtn.textContent = "翻译中...";

  try {
    const tgt = targetLang.value;
    const tgtLabel = langLabel(tgt);
    const { detectedLang, translatedText: result, sameLanguage } = await translateText(text, tgt);

    if (sameLanguage) {
      outputText.value = text;
      metaInfo.textContent = `原文本已是${detectedLang || tgtLabel}，无需翻译`;
    } else {
      outputText.value = result;
      const srcLabel = detectedLang || "未知";
      metaInfo.textContent = `已从${srcLabel}翻译为${tgtLabel}`;
    }
  } catch (err) {
    outputText.value = `错误：${err.message}`;
    metaInfo.textContent = "翻译失败";
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

settingsIconBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});