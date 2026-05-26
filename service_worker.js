const DEFAULT_SETTINGS = {
  apiBaseUrl: "http://localhost:1234/v1",
  modelName: "hy-mt2-1.8b",
  defaultTargetLanguage: "Chinese",
};

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

async function getCachedTranslation(text, targetLanguage) {
  try {
    const key = `${text}|${targetLanguage}`;
    const db = await initDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction("translations", "readonly");
      const store = tx.objectStore("translations");
      const req = store.get(key);

      req.onsuccess = () => resolve(req.result?.translated || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function setCachedTranslation(text, targetLanguage, translated) {
  try {
    const key = `${text}|${targetLanguage}`;
    const db = await initDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction("translations", "readwrite");
      const store = tx.objectStore("translations");
      const req = store.put({
        key,
        text,
        targetLanguage,
        translated,
        timestamp: Date.now(),
      });

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
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
  } catch (err) {
    console.error("Initialization failed:", err);
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

async function translateText({ text, settings, targetLanguage: explicitTargetLanguage }) {
  const input = typeof text === "string" ? text : String(text ?? "");
  if (!input.trim()) {
    throw new Error("待翻译文本为空");
  }

  const targetLanguage =
    explicitTargetLanguage || settings.defaultTargetLanguage || "Chinese";

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

  const systemPrompt = [
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