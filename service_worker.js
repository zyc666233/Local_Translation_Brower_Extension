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

const CACHE_MAX_ENTRIES = 500;
const CACHE_TTL_MS = 10 * 24 * 60 * 60 * 1000;
const CACHE_MAINTENANCE_THROTTLE_MS = 10 * 60 * 1000;

const MENU_IDS = {
  translateSelection: "translate-selection",
  restoreSelection: "restore-selection",
  translatePage: "translate-page",
  restorePage: "restore-page",
};

const TEST_SENTINEL = "Ping";

let lastCacheMaintenanceAt = 0;

/**
 * IndexedDB
 */
function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("TranslationCache", 1);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains("translations")) {
        db.createObjectStore("translations", {
          keyPath: "key",
        });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getCacheKey(text, targetLanguage) {
  return `${text}|${targetLanguage}`;
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function readCacheRecord(db, key) {
  const tx = db.transaction("translations", "readonly");
  const store = tx.objectStore("translations");

  const req = store.get(key);
  const result = await requestToPromise(req);

  await transactionDone(tx).catch(() => { });

  return result || null;
}

async function putCacheRecord(db, record) {
  const tx = db.transaction("translations", "readwrite");
  const store = tx.objectStore("translations");

  const req = store.put(record);
  await requestToPromise(req);

  await transactionDone(tx);
}

async function deleteCacheKeys(db, keys) {
  if (!Array.isArray(keys) || !keys.length) return;

  const tx = db.transaction("translations", "readwrite");
  const store = tx.objectStore("translations");

  for (const key of keys) {
    store.delete(key);
  }

  await transactionDone(tx);
}

async function readAllCacheRecords(db) {
  const tx = db.transaction("translations", "readonly");
  const store = tx.objectStore("translations");

  const req = store.getAll();
  const result = await requestToPromise(req);

  await transactionDone(tx).catch(() => { });

  return Array.isArray(result) ? result : [];
}

function getRecordLastUsedAt(record) {
  return record?.accessedAt ?? record?.createdAt ?? 0;
}

function isRecordExpired(record, now = Date.now()) {
  const lastUsedAt = getRecordLastUsedAt(record);
  if (!lastUsedAt) return true;
  return now - lastUsedAt > CACHE_TTL_MS;
}

async function touchCacheRecord(db, record) {
  if (!record?.key) return;

  await putCacheRecord(db, {
    ...record,
    accessedAt: Date.now(),
  });
}

async function pruneCacheIfNeeded(db, force = false) {
  const now = Date.now();

  if (!force && now - lastCacheMaintenanceAt < CACHE_MAINTENANCE_THROTTLE_MS) {
    return;
  }

  lastCacheMaintenanceAt = now;

  const records = await readAllCacheRecords(db);
  if (!records.length) return;

  const expiredKeys = [];
  const validRecords = [];

  for (const record of records) {
    if (!record?.key) continue;

    if (isRecordExpired(record, now)) {
      expiredKeys.push(record.key);
      continue;
    }

    validRecords.push(record);
  }

  validRecords.sort((a, b) => getRecordLastUsedAt(a) - getRecordLastUsedAt(b));

  const overflowCount = Math.max(0, validRecords.length - CACHE_MAX_ENTRIES);
  const lruKeys = validRecords.slice(0, overflowCount).map((r) => r.key);

  const keysToDelete = [...new Set([...expiredKeys, ...lruKeys])];
  if (!keysToDelete.length) return;

  await deleteCacheKeys(db, keysToDelete);
}

async function getCachedTranslation(text, targetLanguage) {
  try {
    const key = getCacheKey(text, targetLanguage);
    const db = await initDB();
    const record = await readCacheRecord(db, key);

    if (!record?.translated) {
      await pruneCacheIfNeeded(db).catch(() => { });
      return null;
    }

    const now = Date.now();
    if (isRecordExpired(record, now)) {
      await deleteCacheKeys(db, [key]).catch(() => { });
      await pruneCacheIfNeeded(db).catch(() => { });
      return null;
    }

    await touchCacheRecord(db, record).catch(() => { });
    await pruneCacheIfNeeded(db).catch(() => { });

    return record.translated;
  } catch {
    return null;
  }
}

async function setCachedTranslation(text, targetLanguage, translated) {
  try {
    const key = getCacheKey(text, targetLanguage);
    const db = await initDB();
    const now = Date.now();

    await putCacheRecord(db, {
      key,
      text,
      targetLanguage,
      translated,
      createdAt: now,
      accessedAt: now,
    });

    await pruneCacheIfNeeded(db, true);
  } catch (err) {
    console.warn("Cache write error:", err);
  }
}

async function loadSettings() {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...current,
  };
}

async function ensureDefaultSettings() {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({
    ...current,
    ...DEFAULT_SETTINGS,
  });
}

/**
 * Context Menus
 */
async function createContextMenus() {
  await new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => resolve());
  });

  chrome.contextMenus.create({
    id: MENU_IDS.translateSelection,
    title: "翻译选中的文本",
    contexts: ["selection"],
  });

  chrome.contextMenus.create({
    id: MENU_IDS.restoreSelection,
    title: "显示原文本",
    contexts: ["selection"],
  });

  chrome.contextMenus.create({
    id: MENU_IDS.translatePage,
    title: "翻译当前页面",
    contexts: ["page"],
  });

  chrome.contextMenus.create({
    id: MENU_IDS.restorePage,
    title: "显示原页面",
    contexts: ["page"],
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await ensureDefaultSettings();
    await createContextMenus();

    const db = await initDB();
    await pruneCacheIfNeeded(db, true);
  } catch (err) {
    console.error("Initialization failed:", err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await createContextMenus();

    const db = await initDB();
    await pruneCacheIfNeeded(db, true);
  } catch (err) {
    console.error("Startup initialization failed:", err);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === MENU_IDS.translateSelection) {
    chrome.tabs.sendMessage(tab.id, {
      type: "TRANSLATE_SELECTION",
    });
    return;
  }

  if (info.menuItemId === MENU_IDS.restoreSelection) {
    chrome.tabs.sendMessage(tab.id, {
      type: "RESTORE_SELECTION",
    });
    return;
  }

  if (info.menuItemId === MENU_IDS.translatePage) {
    chrome.tabs.sendMessage(tab.id, {
      type: "TRANSLATE_PAGE",
    });
    return;
  }

  if (info.menuItemId === MENU_IDS.restorePage) {
    chrome.tabs.sendMessage(tab.id, {
      type: "RESTORE_PAGE",
    });
    return;
  }
});

/**
 * Runtime Messages
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return false;

  if (message.type === "TRANSLATE_TEXT") {
    (async () => {
      try {
        const settings = await loadSettings();
        const result = await translateText({
          text: message.text,
          settings,
          targetLanguage: message.targetLanguage,
          translationMode: message.translationMode,
        });

        sendResponse({
          ok: true,
          ...result,
        });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();

    return true;
  }

  if (message.type === "TEST_OPENAI_API") {
    (async () => {
      try {
        await testOpenAICompatibleAPI(message.settings);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();

    return true;
  }

  return false;
});

/**
 * Translation
 */
async function translateText({
  text,
  settings,
  targetLanguage: explicitTargetLanguage,
  translationMode,
}) {
  const input = typeof text === "string" ? text : String(text ?? "");

  if (!input.trim()) {
    throw new Error("待翻译文本为空");
  }

  const forcedChineseMode =
    translationMode === "selection" || translationMode === "page";

  const targetLanguage = forcedChineseMode
    ? "Chinese"
    : explicitTargetLanguage || settings.defaultTargetLanguage || "Chinese";

  if (forcedChineseMode && isPureChineseText(input)) {
    return {
      translated: input,
      targetLanguage,
      skipped: true,
      reason: "already_chinese",
    };
  }

  const cached = await getCachedTranslation(input, targetLanguage);
  if (cached) {
    return {
      translated: cached,
      targetLanguage,
      fromCache: true,
    };
  }

  const translated = await requestOpenAICompatibleAPI({
    settings,
    input,
    targetLanguage,
    forcedChineseMode,
    purpose: "translate",
  });

  await setCachedTranslation(input, targetLanguage, translated);

  return {
    translated,
    targetLanguage,
  };
}

/**
 * Helpers
 */
function coerceNumber(value, fallback) {
  const raw = String(value ?? "").trim();
  if (raw === "") return fallback;

  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function coerceProbability(value, fallback) {
  const n = coerceNumber(value, fallback);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function previewText(text) {
  return String(text ?? "").replace(/\s+/g, " ").slice(0, 120);
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

  let extraHeaders = {};
  try {
    extraHeaders = JSON.parse(settings.extraHeaders || "{}");
  } catch {
    extraHeaders = {};
  }

  Object.assign(headers, extraHeaders);
  return headers;
}

function buildChatBody({
  settings,
  input,
  targetLanguage,
  forcedChineseMode,
  purpose,
}) {
  const isTestMode = purpose === "test";

  const systemPrompt = isTestMode
    ? [
      "You are a connection test for an OpenAI-compatible chat API.",
      `Reply with exactly ${TEST_SENTINEL}.`,
      "Do not add any extra characters, punctuation, or whitespace.",
    ].join(" ")
    : forcedChineseMode
      ? [
        "你是一个网页翻译引擎。",
        "目标语言固定为中文。",
        "如果输入已经是中文则原样输出。",
        "请忠实自然地翻译。",
        "只输出翻译结果。",
      ].join(" ")
      : [
        "You are a professional translation engine.",
        `Translate the following text into ${targetLanguage}.`,
        "Output ONLY the translated text.",
      ].join(" ");

  const temperature = isTestMode
    ? 0
    : coerceProbability(settings.temperature, DEFAULT_SETTINGS.temperature);

  const topK = isTestMode ? 1 : coerceNumber(settings.topK, DEFAULT_SETTINGS.topK);

  const topP = isTestMode ? 1 : coerceProbability(settings.topP, DEFAULT_SETTINGS.topP);

  const maxTokens = isTestMode
    ? 8
    : Math.max(1, coerceNumber(settings.maxTokens, DEFAULT_SETTINGS.maxTokens));

  return {
    model: settings.modelName,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: isTestMode ? "Ping" : input,
      },
    ],
    temperature,
    top_k: topK,
    top_p: topP,
    max_tokens: maxTokens,
    stream: false,
    // 关闭思考模式（兼容多种 OpenAI-like 实现）
    reasoning: {
      enabled: false,
    },
    thinking: {
      type: "disabled"
    },
    enable_thinking: false,
  };
}

/**
 * OpenAI Compatible Request
 */
async function requestOpenAICompatibleAPI({
  settings,
  input,
  targetLanguage,
  forcedChineseMode,
  purpose = "translate",
}) {
  const headers = buildRequestHeaders(settings);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, settings.timeoutMs || 120000);

  try {
    const base = settings.apiBaseUrl.replace(/\/$/, "");
    const path = settings.chatPath.startsWith("/")
      ? settings.chatPath
      : `/${settings.chatPath}`;

    const body = buildChatBody({
      settings,
      input,
      targetLanguage,
      forcedChineseMode,
      purpose,
    });
    console.log(body)
    const resp = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      errorDetail = await resp.text();
      if (purpose === "test") {
        throw new Error(`连接测试失败：${errorDetail}`);
      }
      throw new Error(`异常：${errorDetail}`);
    }

    const data = await resp.json();
    console.log(data)
    const content = data?.choices?.[0]?.message?.content;

    if (typeof content !== "string" || !content.trim()) {
      throw new Error(`连接测试失败：模型接口返回为空或格式不正确 ${content}`);
    }

    const normalized = content.trim();

    if (purpose === "test") {
      if (normalized !== TEST_SENTINEL) {
        throw new Error(
          `连接测试失败：模型接口返回了意外内容 "${previewText(normalized)}"`
        );
      }
      return normalized;
    }

    return normalized;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * API Test
 */
async function testOpenAICompatibleAPI(settings) {
  const result = await requestOpenAICompatibleAPI({
    settings,
    input: TEST_SENTINEL,
    targetLanguage: "English",
    forcedChineseMode: false,
    purpose: "test",
  });

  if (result !== TEST_SENTINEL) {
    throw new Error(
      `连接测试失败：模型接口返回结果不符合预期 "${previewText(result)}"`
    );
  }

  return result;
}

/**
 * Utils
 */
function isPureChineseText(text) {
  if (typeof text !== "string") return false;

  const compact = text.trim();
  if (!compact) return false;

  if (/[A-Za-z]/.test(compact)) return false;
  if (!/\p{Script=Han}/u.test(compact)) return false;

  try {
    return (
      LangDetect.detect(compact) ===
      "Chinese"
    );
  } catch {
    return false;
  }
}