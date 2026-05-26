/**
 * content_scripts
 * 功能：
 * 1. 仅响应右键菜单触发的翻译消息
 * 2. 按选区拆分为多个文本节点片段
 * 3. 跳过：纯数字、日期、URL、邮箱、纯标点/符号、纯中文等无需翻译内容
 * 4. 最多 4 个并发调用后台模型服务翻译为中文
 * 5. 同一次选区内，相同文本只翻译一次
 * 6. 每返回一个翻译结果，就立即替换对应文本，实现逐步替换效果
 * 7. 仅替换原位置的文本内容，不修改标签结构和属性
 */

const TRANSLATE_TARGET_LANGUAGE = "Chinese";
const MAX_CONCURRENT_TRANSLATIONS = 4;
let isTranslatingSelection = false;

chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
  if (!message?.type) return false;

  if (message.type === "TRANSLATE_SELECTION") {
    (async () => {
      try {
        const changedSegments = await translateCurrentSelectionInPlace();
        sendResponse({
          ok: true,
          changedSegments,
        });
      } catch (err) {
        console.error("翻译选区失败:", err);
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

async function translateCurrentSelectionInPlace() {
  if (isTranslatingSelection) return null;

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    return null;
  }

  const range = sel.getRangeAt(0);
  const selectedText = sel.toString();

  if (!selectedText || !selectedText.trim()) {
    return null;
  }

  const segments = getSelectionTextNodeSegments(range);
  if (!segments.length) {
    return null;
  }

  isTranslatingSelection = true;

  try {
    const changedSegments = [];

    const textGroups = new Map(); // text -> [segment...]
    for (const segment of segments) {
      const text = segment.selectedPart;
      if (!shouldTranslateText(text)) continue;

      if (!textGroups.has(text)) {
        textGroups.set(text, []);
      }
      textGroups.get(text).push(segment);
    }

    const translationCache = new Map(); // text -> Promise<string> | string
    const uniqueTexts = [...textGroups.keys()];
    const tasks = uniqueTexts.map((text) => async () => {
      const translated = await getTranslationWithCache(text, translationCache);

      if (typeof translated !== "string" || !translated.length) {
        return;
      }

      const relatedSegments = textGroups.get(text) || [];

      for (const segment of relatedSegments) {
        const { textNode, start, end, selectedPart, parentEl } = segment;
        const originalText = textNode.nodeValue || "";

        if (
          !originalText ||
          start < 0 ||
          end > originalText.length ||
          end <= start
        ) {
          continue;
        }

        textNode.nodeValue =
          originalText.slice(0, start) +
          translated +
          originalText.slice(end);

        changedSegments.push({
          originalText: selectedPart,
          translatedText: translated,
          skipped: false,
          tag: parentEl ? parentEl.tagName.toLowerCase() : null,
          href: getAnchorHref(parentEl),
          path: parentEl ? buildDomPath(parentEl) : null,
        });
      }

      await nextFrame();
    });

    await runWithConcurrencyLimit(tasks, MAX_CONCURRENT_TRANSLATIONS);

    for (const segment of segments) {
      if (shouldTranslateText(segment.selectedPart)) continue;

      changedSegments.push({
        originalText: segment.selectedPart,
        translatedText: segment.selectedPart,
        skipped: true,
        reason: getSkipReason(segment.selectedPart),
        tag: segment.parentEl ? segment.parentEl.tagName.toLowerCase() : null,
        href: getAnchorHref(segment.parentEl),
        path: segment.parentEl ? buildDomPath(segment.parentEl) : null,
      });
    }

    sel.removeAllRanges();

    console.log("已翻译并替换选区:", changedSegments);
    return changedSegments;
  } finally {
    isTranslatingSelection = false;
  }
}

async function getTranslationWithCache(text, cacheMap) {
  const cached = cacheMap.get(text);

  if (typeof cached === "string") {
    return cached;
  }

  if (cached && typeof cached.then === "function") {
    return cached;
  }

  const pendingPromise = translateTextViaBackground(text)
    .then((translated) => {
      cacheMap.set(text, translated);
      return translated;
    })
    .catch((err) => {
      cacheMap.delete(text);
      throw err;
    });

  cacheMap.set(text, pendingPromise);
  return pendingPromise;
}

function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function runWithConcurrencyLimit(tasks, limit) {
  if (!Array.isArray(tasks) || tasks.length === 0) return;

  const workerCount = Math.max(1, Math.min(limit || 1, tasks.length));
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= tasks.length) break;

      const task = tasks[currentIndex];

      try {
        await task();
      } catch (err) {
        console.warn("翻译任务失败：", err);
      }
    }
  });

  await Promise.all(workers);
}

function shouldTranslateText(text) {
  if (typeof text !== "string") return false;

  const compact = text.trim();
  if (!compact) return false;

  const stripped = compact.replace(/\s+/g, "");
  if (!stripped) return false;

  if (isPureChineseText(stripped)) return false;
  if (isPurePunctuationOrSymbols(stripped)) return false;
  if (isLikelyEmail(stripped)) return false;
  if (isLikelyUrl(stripped)) return false;
  if (isLikelyDate(stripped)) return false;
  if (isNumericLike(stripped)) return false;

  return true;
}

function getSkipReason(text) {
  const compact = typeof text === "string" ? text.trim().replace(/\s+/g, "") : "";

  if (!compact) return "empty";
  if (isPureChineseText(compact)) return "pure_chinese";
  if (isPurePunctuationOrSymbols(compact)) return "pure_punctuation_or_symbols";
  if (isLikelyEmail(compact)) return "email";
  if (isLikelyUrl(compact)) return "url";
  if (isLikelyDate(compact)) return "date";
  if (isNumericLike(compact)) return "numeric";

  return "unknown";
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

function isPurePunctuationOrSymbols(text) {
  return /^[\p{P}\p{S}]+$/u.test(text);
}

function isLikelyEmail(text) {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(text);
}

function isLikelyUrl(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;

  // 选区文本里只要有空白，基本就不是单独的 URL 片段
  // 这样可以避免 "StreamChannel wrappers for WebSockets." 这类句子被误判
  if (/\s/.test(t)) return false;

  // 先去掉常见包裹符号，减少误判
  const cleaned = t.replace(/^[('"“<\[]+|[)'”>\].,;:!?]+$/g, "");
  if (!cleaned) return false;

  // 1) 明确的协议 URL
  if (/^(https?|ftp|file):\/\/[^\s/$.?#].[^\s]*$/i.test(cleaned)) {
    return true;
  }

  // 2) www 开头
  if (/^www\.[^\s/$.?#].[^\s]*$/i.test(cleaned)) {
    return true;
  }

  // 3) 仅把“非常像域名/路径”的内容当 URL
  //    注意：这里故意比之前严格很多，避免 retrofit.dart 这类误判
  try {
    const normalized = `https://${cleaned}`;
    const url = new URL(normalized);

    const host = url.hostname;
    if (!host || !host.includes(".")) return false;

    // host 必须只包含合法域名字符
    if (!/^[a-z0-9.-]+$/i.test(host)) return false;

    // 允许：
    // - www.example.com
    // - example.com/path
    // - example.com?x=1
    // - example.com#hash
    //
    // 但对像 retrofit.dart 这种“单个点、无路径、无参数”的短词组，直接放行不判 URL
    const hasPathOrQueryOrHash =
      (url.pathname && url.pathname !== "/") || url.search || url.hash;

    const dotCount = (host.match(/\./g) || []).length;

    // 过于短、过于像普通单词的内容，不当作 URL
    // 例如 retrofit.dart / source_gen / WebSockets 这类都不会误中
    if (dotCount === 1 && !hasPathOrQueryOrHash) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function isLikelyDate(text) {
  const t = text.trim();

  const datePatterns = [
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/,
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}[T\s]\d{1,2}:\d{2}(:\d{2})?(?:Z|[+\-]\d{2}:?\d{2})?$/,
    /^\d{4}年\d{1,2}月(?:\d{1,2}[日号]?)?$/,
    /^\d{1,2}月(?:\d{1,2}[日号]?)?$/,
    /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/,
  ];

  return datePatterns.some((re) => re.test(t));
}

function isNumericLike(text) {
  const t = text.trim();
  if (!t) return false;

  return (
    /^[+\-−—]?(?:\p{N}|\d)[\p{N}\d,.\s:%/\\()（）￥$€£¥·+-]*$/u.test(t) &&
    !/[\p{L}\p{Script=Han}]/u.test(t)
  );
}

function translateTextViaBackground(text) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "TRANSLATE_TEXT",
        text,
        targetLanguage: TRANSLATE_TARGET_LANGUAGE,
        translationMode: "selection",
      },
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

        resolve(response.translated);
      }
    );
  });
}

function getSelectionTextNodeSegments(range) {
  const commonAncestor =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;

  if (!commonAncestor) return [];

  const walker = document.createTreeWalker(
    commonAncestor,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const text = node.nodeValue || "";
        if (!text.trim()) return NodeFilter.FILTER_REJECT;

        try {
          return range.intersectsNode(node)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        } catch (e) {
          return NodeFilter.FILTER_REJECT;
        }
      },
    }
  );

  const segments = [];
  const seen = new Set();

  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    const parentEl = textNode.parentElement;
    if (!parentEl) continue;

    const bounds = getSelectedBoundsInTextNode(textNode, range);
    if (!bounds) continue;

    const { start, end } = bounds;
    const fullText = textNode.nodeValue || "";
    const selectedPart = fullText.slice(start, end);

    if (!selectedPart.trim()) continue;

    const key = `${buildDomPath(parentEl)}::${start}-${end}::${selectedPart}`;
    if (seen.has(key)) continue;
    seen.add(key);

    segments.push({
      textNode,
      parentEl,
      start,
      end,
      selectedPart,
    });
  }

  return segments;
}

function getSelectedBoundsInTextNode(textNode, range) {
  const fullText = textNode.nodeValue || "";
  if (!fullText) return null;

  try {
    if (!range.intersectsNode(textNode)) {
      return null;
    }
  } catch (e) {
    return null;
  }

  let start = 0;
  let end = fullText.length;

  if (textNode === range.startContainer && textNode.nodeType === Node.TEXT_NODE) {
    start = range.startOffset;
  }

  if (textNode === range.endContainer && textNode.nodeType === Node.TEXT_NODE) {
    end = range.endOffset;
  }

  if (start < 0) start = 0;
  if (end > fullText.length) end = fullText.length;
  if (end <= start) return null;

  return { start, end };
}

function getAnchorHref(parentEl) {
  if (!parentEl) return null;
  const anchor = parentEl.closest("a");
  return anchor ? anchor.href : null;
}

function buildDomPath(el) {
  const parts = [];
  let current = el;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let part = current.tagName.toLowerCase();

    if (current.id) {
      part += `#${current.id}`;
      parts.unshift(part);
      break;
    }

    if (current.classList && current.classList.length > 0) {
      part += "." + Array.from(current.classList).slice(0, 2).join(".");
    }

    const parent = current.parentElement;
    if (parent) {
      const sameTagSiblings = Array.from(parent.children).filter(
        (child) => child.tagName === current.tagName
      );
      if (sameTagSiblings.length > 1) {
        const index = sameTagSiblings.indexOf(current) + 1;
        part += `:nth-of-type(${index})`;
      }
    }

    parts.unshift(part);
    current = current.parentElement;
  }

  return parts.join(" > ");
}