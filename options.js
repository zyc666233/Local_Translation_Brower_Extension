const DEFAULT_SETTINGS = {
  apiBaseUrl: "http://localhost:1234/v1",
  chatPath: "/chat/completions",
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

const NUMERIC_DEFAULTS = {
  temperature: 0.7,
  topK: 20,
  topP: 0.6,
  maxTokens: 4096,
};

const API_KEY_PLACEHOLDER = "sk-xxxx";

const els = {
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  chatPath: document.getElementById("chatPath"),
  modelName: document.getElementById("modelName"),
  defaultTargetLanguage: document.getElementById("defaultTargetLanguage"),
  apiKey: document.getElementById("apiKey"),
  apiKeyHeader: document.getElementById("apiKeyHeader"),
  apiKeyPrefix: document.getElementById("apiKeyPrefix"),
  temperature: document.getElementById("temperature"),
  topK: document.getElementById("topK"),
  topP: document.getElementById("topP"),
  maxTokens: document.getElementById("maxTokens"),
  timeoutMs: document.getElementById("timeoutMs"),
  extraHeaders: document.getElementById("extraHeaders"),
  saveBtn: document.getElementById("saveBtn"),
  testBtn: document.getElementById("testBtn"),
  status: document.getElementById("status"),
};

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.className = isError ? "status error" : "status success";
}

function toNumberValue(value, fallback) {
  const raw = String(value ?? "").trim();
  if (raw === "") return fallback;

  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bindDefaultFillBehavior(inputEl, defaultValue) {
  if (!inputEl) return;

  inputEl.placeholder = String(defaultValue);

  inputEl.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Tab") return;

      const currentValue = String(inputEl.value || "").trim();
      if (currentValue) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      inputEl.value = String(defaultValue);
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));

      const len = inputEl.value.length;
      try {
        inputEl.setSelectionRange(len, len);
      } catch {
        // 某些 input 类型不支持 setSelectionRange，忽略
      }
    },
    true
  );
}

function setTextFieldValue(inputEl, savedValue, defaultValue) {
  if (!inputEl) return;

  inputEl.placeholder = String(defaultValue);

  const normalized =
    savedValue === undefined || savedValue === null
      ? ""
      : String(savedValue).trim();

  inputEl.value =
    normalized && normalized !== String(defaultValue) ? normalized : "";
}

function setNumericFieldValue(inputEl, savedValue, defaultValue) {
  if (!inputEl) return;

  inputEl.placeholder = String(defaultValue);

  const normalized =
    savedValue === undefined || savedValue === null
      ? ""
      : String(savedValue).trim();

  inputEl.value =
    normalized && normalized !== String(defaultValue) ? normalized : "";
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

  setTextFieldValue(els.apiBaseUrl, settings.apiBaseUrl, DEFAULT_SETTINGS.apiBaseUrl);
  setTextFieldValue(els.chatPath, settings.chatPath, DEFAULT_SETTINGS.chatPath);
  setTextFieldValue(els.modelName, settings.modelName, DEFAULT_SETTINGS.modelName);
  setTextFieldValue(
    els.apiKeyHeader,
    settings.apiKeyHeader,
    DEFAULT_SETTINGS.apiKeyHeader
  );
  setTextFieldValue(
    els.apiKeyPrefix,
    settings.apiKeyPrefix,
    DEFAULT_SETTINGS.apiKeyPrefix
  );
  setTextFieldValue(els.apiKey, settings.apiKey, API_KEY_PLACEHOLDER);
  setTextFieldValue(
    els.extraHeaders,
    settings.extraHeaders,
    DEFAULT_SETTINGS.extraHeaders
  );
  setTextFieldValue(
    els.timeoutMs,
    settings.timeoutMs,
    DEFAULT_SETTINGS.timeoutMs
  );

  els.defaultTargetLanguage.value =
    settings.defaultTargetLanguage ?? DEFAULT_SETTINGS.defaultTargetLanguage;

  setNumericFieldValue(
    els.temperature,
    settings.temperature,
    NUMERIC_DEFAULTS.temperature
  );
  setNumericFieldValue(els.topK, settings.topK, NUMERIC_DEFAULTS.topK);
  setNumericFieldValue(els.topP, settings.topP, NUMERIC_DEFAULTS.topP);
  setNumericFieldValue(
    els.maxTokens,
    settings.maxTokens,
    NUMERIC_DEFAULTS.maxTokens
  );

  bindDefaultFillBehavior(els.apiBaseUrl, DEFAULT_SETTINGS.apiBaseUrl);
  bindDefaultFillBehavior(els.chatPath, DEFAULT_SETTINGS.chatPath);
  bindDefaultFillBehavior(els.modelName, DEFAULT_SETTINGS.modelName);
  bindDefaultFillBehavior(els.apiKeyHeader, DEFAULT_SETTINGS.apiKeyHeader);
  bindDefaultFillBehavior(els.apiKeyPrefix, DEFAULT_SETTINGS.apiKeyPrefix);
  bindDefaultFillBehavior(els.apiKey, API_KEY_PLACEHOLDER);
  bindDefaultFillBehavior(els.timeoutMs, DEFAULT_SETTINGS.timeoutMs);

  bindDefaultFillBehavior(els.temperature, NUMERIC_DEFAULTS.temperature);
  bindDefaultFillBehavior(els.topK, NUMERIC_DEFAULTS.topK);
  bindDefaultFillBehavior(els.topP, NUMERIC_DEFAULTS.topP);
  bindDefaultFillBehavior(els.maxTokens, NUMERIC_DEFAULTS.maxTokens);
}

function getSettingsFromUI() {
  return {
    apiBaseUrl: els.apiBaseUrl.value.trim() || DEFAULT_SETTINGS.apiBaseUrl,
    chatPath: els.chatPath.value.trim() || DEFAULT_SETTINGS.chatPath,
    modelName: els.modelName.value.trim() || DEFAULT_SETTINGS.modelName,
    defaultTargetLanguage: els.defaultTargetLanguage.value,
    apiKey: els.apiKey.value.trim(),
    apiKeyHeader: els.apiKeyHeader.value.trim() || DEFAULT_SETTINGS.apiKeyHeader,
    apiKeyPrefix: els.apiKeyPrefix.value.trim(),
    temperature: toNumberValue(els.temperature.value, NUMERIC_DEFAULTS.temperature),
    topK: toNumberValue(els.topK.value, NUMERIC_DEFAULTS.topK),
    topP: toNumberValue(els.topP.value, NUMERIC_DEFAULTS.topP),
    maxTokens: toNumberValue(els.maxTokens.value, NUMERIC_DEFAULTS.maxTokens),
    timeoutMs: toNumberValue(els.timeoutMs.value, DEFAULT_SETTINGS.timeoutMs),
    extraHeaders: els.extraHeaders.value.trim() || "{}",
  };
}

function validateSettings(settings) {
  if (!settings.apiBaseUrl) {
    throw new Error("API Base URL 不能为空");
  }
  if (!settings.chatPath) {
    throw new Error("Chat Completions Path 不能为空");
  }
  if (!settings.modelName) {
    throw new Error("Model Name 不能为空");
  }

  if (Number.isNaN(settings.temperature)) {
    throw new Error("Temperature 必须是数字");
  }
  if (Number.isNaN(settings.topK)) {
    throw new Error("Top K 必须是数字");
  }
  if (Number.isNaN(settings.topP)) {
    throw new Error("Top P 必须是数字");
  }
  if (Number.isNaN(settings.maxTokens)) {
    throw new Error("Max Tokens 必须是数字");
  }
  if (Number.isNaN(settings.timeoutMs)) {
    throw new Error("Request Timeout 必须是数字");
  }

  if (settings.temperature < 0 || settings.temperature > 1) {
    throw new Error("Temperature 必须在 0 到 1 之间");
  }
  if (settings.topP < 0 || settings.topP > 1) {
    throw new Error("Top P 必须在 0 到 1 之间");
  }

  try {
    JSON.parse(settings.extraHeaders || "{}");
  } catch {
    throw new Error("Additional Headers 必须是合法 JSON");
  }
}

async function saveSettings() {
  try {
    const settings = getSettingsFromUI();
    validateSettings(settings);

    await chrome.storage.sync.set(settings);
    setStatus("Settings saved");
    setTimeout(() => setStatus(""), 1200);
  } catch (err) {
    setStatus(err?.message || String(err), true);
  }
}

async function testConnection() {
  try {
    const settings = getSettingsFromUI();
    validateSettings(settings);

    setStatus("Testing connection...");

    const resp = await chrome.runtime.sendMessage({
      type: "TEST_OPENAI_API",
      settings,
    });

    if (!resp?.ok) {
      throw new Error(resp?.error || "Connection failed");
    }

    setStatus("Connection successful");
    setTimeout(() => setStatus(""), 1200);
  } catch (err) {
    setStatus(err?.message || String(err), true);
  }
}

els.saveBtn.addEventListener("click", saveSettings);
els.testBtn.addEventListener("click", testConnection);

loadSettings();