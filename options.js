const DEFAULT_SETTINGS = {
  apiBaseUrl: "https://api.openai.com/v1",
  chatPath: "/chat/completions",
  modelName: "gpt-4o-mini",
  apiKey: "",
  apiKeyHeader: "Authorization",
  apiKeyPrefix: "Bearer",
  temperature: 0,
  topK: 40,
  topP: 0.9,
  maxTokens: 2048,
  timeoutMs: 120000,
  extraHeaders: "{}",
  defaultTargetLanguage: "Chinese",
};

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
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

  els.apiBaseUrl.value = settings.apiBaseUrl ?? DEFAULT_SETTINGS.apiBaseUrl;
  els.chatPath.value = settings.chatPath ?? DEFAULT_SETTINGS.chatPath;
  els.modelName.value = settings.modelName ?? DEFAULT_SETTINGS.modelName;
  els.defaultTargetLanguage.value =
    settings.defaultTargetLanguage ?? DEFAULT_SETTINGS.defaultTargetLanguage;
  els.apiKey.value = settings.apiKey ?? "";
  els.apiKeyHeader.value = settings.apiKeyHeader ?? DEFAULT_SETTINGS.apiKeyHeader;
  els.apiKeyPrefix.value = settings.apiKeyPrefix ?? DEFAULT_SETTINGS.apiKeyPrefix;
  els.temperature.value = settings.temperature ?? DEFAULT_SETTINGS.temperature;
  els.topK.value = settings.topK ?? DEFAULT_SETTINGS.topK;
  els.topP.value = settings.topP ?? DEFAULT_SETTINGS.topP;
  els.maxTokens.value = settings.maxTokens ?? DEFAULT_SETTINGS.maxTokens;
  els.timeoutMs.value = settings.timeoutMs ?? DEFAULT_SETTINGS.timeoutMs;
  els.extraHeaders.value = settings.extraHeaders ?? DEFAULT_SETTINGS.extraHeaders;
}

function getSettingsFromUI() {
  return {
    apiBaseUrl: els.apiBaseUrl.value.trim(),
    chatPath: els.chatPath.value.trim() || "/chat/completions",
    modelName: els.modelName.value.trim(),
    defaultTargetLanguage: els.defaultTargetLanguage.value,
    apiKey: els.apiKey.value.trim(),
    apiKeyHeader: els.apiKeyHeader.value.trim() || "Authorization",
    apiKeyPrefix: els.apiKeyPrefix.value.trim(),
    temperature: toNumberValue(els.temperature.value, 0),
    topK: toNumberValue(els.topK.value, 40),
    topP: toNumberValue(els.topP.value, 0.9),
    maxTokens: toNumberValue(els.maxTokens.value, 2048),
    timeoutMs: toNumberValue(els.timeoutMs.value, 120000),
    extraHeaders: els.extraHeaders.value.trim() || "{}",
  };
}

function validateSettings(settings) {
  if (!settings.apiBaseUrl) {
    throw new Error("接口基础地址不能为空");
  }
  if (!settings.chatPath) {
    throw new Error("Chat Completions 路径不能为空");
  }
  if (!settings.modelName) {
    throw new Error("模型名称不能为空");
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
    throw new Error("请求超时必须是数字");
  }

  try {
    JSON.parse(settings.extraHeaders || "{}");
  } catch {
    throw new Error("额外请求头必须是合法 JSON");
  }
}

async function saveSettings() {
  try {
    const settings = getSettingsFromUI();
    validateSettings(settings);

    await chrome.storage.sync.set(settings);
    setStatus("设置已保存");
    setTimeout(() => setStatus(""), 1200);
  } catch (err) {
    setStatus(err?.message || String(err), true);
  }
}

async function testConnection() {
  try {
    const settings = getSettingsFromUI();
    validateSettings(settings);

    setStatus("正在测试连接...");

    const resp = await chrome.runtime.sendMessage({
      type: "TEST_OPENAI_API",
      settings,
    });

    if (!resp?.ok) {
      throw new Error(resp?.error || "连接失败");
    }

    setStatus("连接成功");
    setTimeout(() => setStatus(""), 1200);
  } catch (err) {
    setStatus(err?.message || String(err), true);
  }
}

els.saveBtn.addEventListener("click", saveSettings);
els.testBtn.addEventListener("click", testConnection);

loadSettings();