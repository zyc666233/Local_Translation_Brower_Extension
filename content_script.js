let pageState = {
  isTranslated: false,
  translationMap: new Map(),
  showingOriginal: false,
};

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

function detectSourceLanguage(text) {
  const cleaned = (text || "").trim();
  if (!cleaned) return 'other';
  
  // Count different character types
  const chineseChars = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinChars = (cleaned.match(/[a-zA-Z]/g) || []).length;
  const diacriticChars = (cleaned.match(/[äöüßçéèêëàâôüüèøåñáíóú]/gi) || []).length;
  
  // If has Chinese characters and more Chinese than Latin, it's Chinese
  if (chineseChars > 0 && chineseChars >= latinChars) return 'zh';
  
  // If has diacritics, try to identify language
  if (diacriticChars > 0) {
    const germanCount = (cleaned.match(/[äöüß]/gi) || []).length;
    const frenchCount = (cleaned.match(/[çéèêëàâôûü]/gi) || []).length;
    const spanishCount = (cleaned.match(/[ñáéíóú]/gi) || []).length;
    
    if (germanCount > 0) return 'de';
    if (frenchCount >= 2) return 'fr';
    if (spanishCount >= 2) return 'es';
  }
  
  // Check for non-Latin scripts
  const japaneseChars = (cleaned.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
  if (japaneseChars >= 1) return 'ja';
  
  const koreanChars = (cleaned.match(/[\uac00-\ud7af]/g) || []).length;
  if (koreanChars >= 1) return 'ko';
  
  const cyrillicChars = (cleaned.match(/[\u0400-\u04ff]/g) || []).length;
  if (cyrillicChars >= 2) return 'ru';
  
  const arabicChars = (cleaned.match(/[\u0600-\u06ff]/g) || []).length;
  if (arabicChars >= 2) return 'ar';
  
  // Check for German words (common German words and articles)
  const germanWords = /\b(mich|dich|sich|lich|dein|sein|mein|liebe|schne|schlie|ihre|heißt|über|auch|noch|nur|mehr|nicht|ganz|sehr|bereits|zusammen|ich|bin|ein|eine|und|der|die|das|ist|du|er|sie|es|wir|ihr|euch|eure|unsere|unseren|sind|habe|hat|haben|wird|werde|würde)\b/i;
  if (germanWords.test(cleaned)) return 'de';
  
  // Check for French words (common French articles and words)
  const frenchWords = /\b(le|la|les|de|du|des|une|un|et|je|tu|il|elle|nous|vous|elles|ils|qu|pas|plus|dans|pour|avec|par|est|sont|avoir|au|à|mon|ma|mes|ton|ta|tes|son|sa|ses|notre|votre|leur|sur|sous|entre|aussi|après|avant|comme)\b/i;
  if (frenchWords.test(cleaned) && !germanWords.test(cleaned)) return 'fr';
  
  // If it's primarily Latin characters with some Chinese, it's likely mixed text
  if (latinChars > 0 && chineseChars > 0 && chineseChars < latinChars) {
    // Mixed text - already checked for German above
    return 'other';
  }
  
  // Default: treat as English/other
  return 'other';
}

async function translateSelection(text) {
  if (!text || !text.trim()) return;
  const translated = await sendTranslateRequest(text);
  alert(translated.translated);
}

async function concurrentTranslate(textsToTranslate, concurrencyLimit = 8) {
  const results = new Map();
  const queue = Array.from(textsToTranslate);
  
  const executeQueue = async () => {
    const promises = [];
    while (queue.length > 0) {
      const text = queue.shift();
      const promise = sendTranslateRequest(text)
        .then(result => {
          results.set(text, result.translated);
        })
        .catch(err => {
          console.error("翻译失败：", err);
          results.set(text, text);
        });
      promises.push(promise);
      
      if (promises.length >= concurrencyLimit) {
        await Promise.all(promises);
        promises.length = 0;
      }
    }
    
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  };
  
  await executeQueue();
  return results;
}

function toggleTranslation() {
  if (!pageState.isTranslated) return;

  pageState.showingOriginal = !pageState.showingOriginal;
  const nodes = walkTextNodes(document.body);

  if (pageState.showingOriginal) {
    for (const node of nodes) {
      if (!node._originalText) continue;
      node.nodeValue = node._originalText;
      delete node._isTranslated;
    }
  } else {
    for (const node of nodes) {
      if (!node._originalText) continue;
      const translated = pageState.translationMap.get(node._originalText);
      if (translated) {
        node.nodeValue = translated;
        node._isTranslated = true;
      }
    }
  }

  // update button label if present
  const btn = document.getElementById('translation-toggle-btn');
  if (btn) btn.textContent = pageState.showingOriginal ? '显示译文' : '显示原文';
}

async function sendTranslateBatch(segments, targetLanguage) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "TRANSLATE_BATCH", segments, targetLanguage }, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "批量翻译失败"));
        return;
      }
      resolve(response.translations || []);
    });
  });
}

async function translatePage() {
  const nodes = walkTextNodes(document.body);
  const items = [];

  for (const node of nodes) {
    const text = node.nodeValue;
    if (!text || !text.trim()) continue;
    if (text.trim().length < 2) continue;
    if (isChineseText(text)) continue;

    if (node._originalText === undefined) {
      node._originalText = text;
    }
    items.push({ node, text: node._originalText });
  }

  if (items.length === 0) return;

  // Load settings to decide target language
  const settings = await new Promise((res) =>
    chrome.storage.sync.get(
      {
        apiBaseUrl: "http://localhost:1234/v1",
        modelName: "qwen3.5-9b",
        defaultTargetLanguage: "English",
        pageTranslateTargetForChinese: "English",
        pageTranslateTargetForNonChinese: "Chinese",
      },
      res
    )
  );

  const targetLanguage = settings.pageTranslateTargetForNonChinese || settings.defaultTargetLanguage || "English";

  // Build chunks (merge adjacent items) using smaller chunks for faster partial responses
  const CHUNK_SIZE = 2000; // 2k chars per chunk
  const CONCURRENCY = 4; // number of concurrent batch requests
  const chunks = [];
  let current = { segments: [], nodes: [], length: 0 };

  for (const it of items) {
    const seg = it.text;
    if (current.segments.length > 0 && current.length + seg.length > CHUNK_SIZE) {
      chunks.push({ ...current, targetLanguage });
      current = { segments: [], nodes: [], length: 0 };
    }
    current.segments.push(seg);
    current.nodes.push(it.node);
    current.length += seg.length;
  }

  if (current.segments.length > 0) chunks.push({ ...current, targetLanguage });

  if (chunks.length === 0) return;

  // Process chunks with concurrency and progressive replacement
  let idx = 0;
  const workers = Array.from({ length: CONCURRENCY }).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= chunks.length) break;
      const chunk = chunks[i];
      try {
        const translations = await sendTranslateBatch(chunk.segments, chunk.targetLanguage);
        for (let j = 0; j < translations.length; j++) {
          const translated = translations[j] || chunk.segments[j];
          const node = chunk.nodes[j];
          const original = node._originalText || chunk.segments[j];
          pageState.translationMap.set(original, translated);
          node.nodeValue = translated;
          node._isTranslated = true;
        }
      } catch (err) {
        console.error("Chunk 翻译错误：", err);
        // on error, skip this chunk (leave original)
      }
    }
  });

  await Promise.all(workers);

  pageState.isTranslated = true;
  // Only show toggle button after full page translation complete
  addToggleButton();
}


function addToggleButton() {
  if (document.getElementById('translation-toggle-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'translation-toggle-btn';
  btn.textContent = '显示原文';
  btn.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    padding: 8px 12px;
    background: #1f6feb;
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    touch-action: none;
  `;

  // Restore saved position if any
  try {
    const saved = localStorage.getItem('translationToggleBtnPos');
    if (saved) {
      const p = JSON.parse(saved);
      if (typeof p.left === 'number' && typeof p.top === 'number') {
        btn.style.left = p.left + 'px';
        btn.style.top = p.top + 'px';
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
      }
    }
  } catch (e) {}

  let dragTimer = null;
  let dragging = false;
  let startX = 0, startY = 0, offsetX = 0, offsetY = 0;

  const onPointerMove = (ev) => {
    if (!dragging) return;
    const x = ev.clientX - offsetX;
    const y = ev.clientY - offsetY;
    btn.style.left = Math.max(0, Math.min(window.innerWidth - btn.offsetWidth, x)) + 'px';
    btn.style.top = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, y)) + 'px';
  };

  const endDrag = (ev) => {
    if (dragTimer) { clearTimeout(dragTimer); dragTimer = null; }
    if (dragging) {
      dragging = false;
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', endDrag);
      // Save position
      try {
        const left = parseInt(btn.style.left, 10) || btn.getBoundingClientRect().left;
        const top = parseInt(btn.style.top, 10) || btn.getBoundingClientRect().top;
        localStorage.setItem('translationToggleBtnPos', JSON.stringify({ left, top }));
      } catch (e) {}
      return;
    }

    // It was a click (short press)
    // Toggle translation
    toggleTranslation();
  };

  btn.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    startX = ev.clientX; startY = ev.clientY;
    const rect = btn.getBoundingClientRect();
    offsetX = startX - rect.left; offsetY = startY - rect.top;

    dragTimer = setTimeout(() => {
      // start dragging
      dragging = true;
      // convert to left/top absolute if currently using bottom/right
      const r = btn.getBoundingClientRect();
      btn.style.left = r.left + 'px';
      btn.style.top = r.top + 'px';
      btn.style.right = 'auto';
      btn.style.bottom = 'auto';
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', endDrag);
    }, 250); // long press threshold

    document.addEventListener('pointerup', endDrag);
  });

  btn.addEventListener('pointercancel', endDrag);

  document.body.appendChild(btn);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "TRANSLATE_SELECTION") {
    translateSelection(message.text || "");
  }

  if (message?.type === "TRANSLATE_PAGE") {
    translatePage();
  }

  if (message?.type === "TOGGLE_TRANSLATION") {
    toggleTranslation();
  }
  
  if (message?.type === "DETECT_LANGUAGE") {
    const sourceLanguage = detectSourceLanguage(message.text || "");
    sendResponse({ language: sourceLanguage });
    return true;
  }
});
