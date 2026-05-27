const DEFAULT_SETTINGS = {
  apiBaseUrl: "http://localhost:1234/v1",
  modelName: "hy-mt2-1.8b",
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

  const apiBaseUrl = settings.apiBaseUrl.replace(/\/$/, "");
  const modelName = settings.modelName;

  const systemPrompt = forcedChineseMode
    ? [
        "你是一个网页划词/整页翻译引擎。",
        "目标语言固定为中文。",
        "如果输入文本本身已经是纯中文，直接原样输出。",
        "如果输入不是中文，请忠实、自然地翻译为中文。",
        "只输出翻译结果，不要添加任何解释、注释、前缀或后缀。",
      ].join(" ")
    : [
        "You are a professional translation engine.",
        `Translate the following text into ${targetLanguage}.`,
        "Translate faithfully and naturally. Preserve meaning, tone, punctuation, formatting, HTML tags, and placeholders.",
        "Output ONLY the translated text, no extra commentary.",
      ].join(" ");

  const resp = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ],
      temperature: 0,
      top_p: 0.9,
      stream: false,
    }),
  });

  if (!resp.ok) {
    throw new Error(await resp.text());
  }

  const data = await resp.json();
  const translated = data?.choices?.[0]?.message?.content?.trim() || input;

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

  if (/[A-Za-z]/.test(compact)) return false;
  if (!/\p{Script=Han}/u.test(compact)) return false;

  try {
    return LangDetect.detect(compact) === "Chinese";
  } catch {
    return false;
  }
}