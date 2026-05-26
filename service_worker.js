const DEFAULT_SETTINGS = {
  apiBaseUrl: "http://localhost:1234/v1",
  modelName: "hy-mt2-1.8b",
  defaultTargetLanguage: "Chinese",
};

const CACHE_MAX_ENTRIES = 500;
const CACHE_TTL_MS = 10 * 24 * 60 * 60 * 1000; // 10 天
const CACHE_MAINTENANCE_THROTTLE_MS = 10 * 60 * 1000; // 10 分钟
let lastCacheMaintenanceAt = 0;

function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("TranslationCache", 1);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("translations")) {
        db.createObjectStore("translations", { keyPath: "key" });
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
  const record = await requestToPromise(req);
  await transactionDone(tx).catch(() => {});
  return record || null;
}

async function putCacheRecord(db, record) {
  const tx = db.transaction("translations", "readwrite");
  const store = tx.objectStore("translations");
  const req = store.put(record);
  await requestToPromise(req);
  await transactionDone(tx);
}

async function deleteCacheKeys(db, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return;

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
  const records = await requestToPromise(req);
  await transactionDone(tx).catch(() => {});
  return Array.isArray(records) ? records : [];
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

  const now = Date.now();
  const nextRecord = {
    ...record,
    accessedAt: now,
  };

  await putCacheRecord(db, nextRecord);
}

async function pruneCacheIfNeeded(db, force = false) {
  const now = Date.now();

  if (!force && now - lastCacheMaintenanceAt < CACHE_MAINTENANCE_THROTTLE_MS) {
    return;
  }

  lastCacheMaintenanceAt = now;

  const allRecords = await readAllCacheRecords(db);
  if (!allRecords.length) return;

  const expiredKeys = [];
  const validRecords = [];

  for (const record of allRecords) {
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
      await pruneCacheIfNeeded(db).catch(() => {});
      return null;
    }

    const now = Date.now();
    if (isRecordExpired(record, now)) {
      await deleteCacheKeys(db, [key]).catch(() => {});
      await pruneCacheIfNeeded(db).catch(() => {});
      return null;
    }

    await touchCacheRecord(db, record).catch(() => {});
    await pruneCacheIfNeeded(db).catch(() => {});

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

async function createContextMenus() {
  await new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => resolve());
  });

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

        sendResponse({ ok: true, ...result });
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

  const isSelectionMode = translationMode === "selection";

  const targetLanguage = isSelectionMode
    ? "Chinese"
    : explicitTargetLanguage || settings.defaultTargetLanguage || "Chinese";

  if (isSelectionMode && isPureChineseText(input)) {
    return {
      translated: input,
      targetLanguage,
      fromCache: false,
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

  const apiBaseUrl = settings.apiBaseUrl.replace(/\/$/, "");
  const modelName = settings.modelName;

  const systemPrompt = isSelectionMode
    ? [
        "你是一个专业翻译引擎。",
        "目标语言固定为中文。",
        "如果输入文本本身已经是纯中文，直接原样输出，不要改写，不要润色，不要补充。",
        "如果输入不是中文，请忠实、自然地翻译为中文。",
        "只输出最终结果，不要添加任何解释、注释、前缀或后缀。",
      ].join(" ")
    : [
        "你是一个专业翻译引擎。",
        "请忠实、自然地将用户输入的文本翻译成目标语言。",
        "只输出翻译结果，不要添加任何解释、注释、前缀或后缀。",
        `请将输入文本翻译为${targetLanguage}。`,
      ].join(" ");

  const body = {
    model: modelName,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: input },
    ],
    temperature: 0,
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

  await setCachedTranslation(input, targetLanguage, translated);

  return {
    translated,
    targetLanguage,
  };
}

function isPureChineseText(text) {
  if (typeof text !== "string") return false;

  const compact = text.trim();
  if (!compact) return false;

  // 只要出现拉丁字母，就不按“纯中文”处理
  if (/[A-Za-z]/.test(compact)) {
    return false;
  }

  // 至少要有一个汉字
  if (!/\p{Script=Han}/u.test(compact)) {
    return false;
  }

  try {
    return LangDetect.detect(compact) === "Chinese";
  } catch (err) {
    console.warn("LangDetect.detect failed:", err);
    return false;
  }
}