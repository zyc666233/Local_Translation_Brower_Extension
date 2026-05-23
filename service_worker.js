const DEFAULT_SETTINGS = {
  apiBaseUrl: "http://localhost:1234/v1",
  modelName: "qwen3.5-9b",
  defaultTargetLanguage: "English",
  autoTranslatePage: true,
  pageTranslateTargetForChinese: "English",
  pageTranslateTargetForNonChinese: "Chinese",
};

let translationCache = {};

function initDB() {
  return new Promise((resolve) => {
    const req = indexedDB.open('TranslationCache', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('translations')) {
        db.createObjectStore('translations', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function getCachedTranslation(text, targetLanguage) {
  try {
    const key = `${text}|${targetLanguage}`;
    const db = await initDB();
    return new Promise((resolve) => {
      const tx = db.transaction('translations', 'readonly');
      const store = tx.objectStore('translations');
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result?.translated);
    });
  } catch {
    return null;
  }
}

async function setCachedTranslation(text, targetLanguage, translated) {
  try {
    const key = `${text}|${targetLanguage}`;
    const db = await initDB();
    const tx = db.transaction('translations', 'readwrite');
    const store = tx.objectStore('translations');
    store.put({ key, text, targetLanguage, translated, timestamp: Date.now() });
  } catch (err) {
    console.warn('Cache write error:', err);
  }
}

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
  if (!message?.type) return;

  // Single-text translation (legacy)
  if (message.type === "TRANSLATE_TEXT") {
    (async () => {
      try {
        const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
        const result = await translateText({
          text: message.text,
          settings,
          tabId: sender.tab.id,
        });
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();

    return true;
  }

  // Batch translation: segments array -> returns translations array (same order)
  if (message.type === "TRANSLATE_BATCH") {
    (async () => {
      try {
        const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
        const segments = Array.isArray(message.segments) ? message.segments : [];
        const targetLanguage = message.targetLanguage || (settings.pageTranslateTargetForNonChinese || settings.defaultTargetLanguage || "English");

        const translations = new Array(segments.length);
        const missingIndices = [];

        // Check cache for each segment
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i];
          const cached = await getCachedTranslation(seg, targetLanguage);
          if (cached) {
            translations[i] = cached;
          } else {
            missingIndices.push(i);
          }
        }

        if (missingIndices.length > 0) {
          const missingSegments = missingIndices.map((i) => segments[i]);
          const delimiter = '<<<TX_BOUNDARY_123456>>>';

          const systemPrompt = [
            "You are a professional translation engine.",
            "Translate faithfully and naturally.",
            `Output only the translated segments separated by the exact token ${delimiter} with no extra text. Do NOT modify the delimiter.`,
            "Preserve meaning, tone, punctuation, HTML tags, placeholders, and code blocks.",
            `Translate the input into ${targetLanguage}.`,
          ].join(" ");

          const body = {
            model: settings.modelName,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: missingSegments.join(delimiter) },
            ],
            temperature: 0,
            top_p: 0.9,
            stream: false,
          };

          const apiBaseUrl = settings.apiBaseUrl.replace(/\/$/, "");
          const resp = await fetch(`${apiBaseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });

          if (!resp.ok) {
            // Fallback: translate missing segments individually
            for (const idx of missingIndices) {
              const r = await translateText({ text: segments[idx], settings, tabId: sender.tab.id });
              translations[idx] = r.translated;
            }
          } else {
            const data = await resp.json();
            const combined = data?.choices?.[0]?.message?.content || "";
            const parts = combined.split(delimiter).map((s) => s.trim());

            if (parts.length !== missingSegments.length) {
              // Fallback to individual if mismatch
              for (const idx of missingIndices) {
                const r = await translateText({ text: segments[idx], settings, tabId: sender.tab.id });
                translations[idx] = r.translated;
              }
            } else {
              for (let k = 0; k < missingIndices.length; k++) {
                const originalIndex = missingIndices[k];
                const tr = parts[k];
                translations[originalIndex] = tr;
                // Cache per-segment
                await setCachedTranslation(segments[originalIndex], targetLanguage, tr);
              }
            }
          }
        }

        // Fill any remaining undefined translations with original text
        for (let i = 0; i < translations.length; i++) {
          if (translations[i] === undefined) translations[i] = segments[i];
        }

        sendResponse({ ok: true, translations });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();

    return true;
  }

  return false;
});

function isChineseText(text) {
  const cleaned = (text || "").trim();
  if (!cleaned) return false;

  const chineseChars = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (cleaned.match(/[A-Za-z\u00C0-\u024F\u0400-\u04FF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;

  if (chineseChars >= Math.max(2, letters)) return true;
  return false;
}

function detectSourceLanguageViaContent(text, tabId) {
  // Try to detect language via content script (which has access to better detection)
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "DETECT_LANGUAGE", text }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(isChineseText(text) ? 'zh' : 'other');
        } else if (response?.language) {
          resolve(response.language);
        } else {
          resolve(isChineseText(text) ? 'zh' : 'other');
        }
      });
    } catch (e) {
      resolve(isChineseText(text) ? 'zh' : 'other');
    }
  });
}

async function translateText({ text, settings, tabId, targetLanguage: explicitTargetLanguage }) {
  // Use explicitly provided target language, or default from settings
  const targetLanguage = explicitTargetLanguage || settings.defaultTargetLanguage || "Chinese";

  const cached = await getCachedTranslation(text, targetLanguage);
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
    "You are a professional translation engine.",
    "Automatically detect the source language and translate it faithfully and naturally.",
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

  await setCachedTranslation(text, targetLanguage, translated);

  return {
    translated,
    targetLanguage,
  };
}
