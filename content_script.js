/**
 * content_scripts
 * 功能：
 * 1. 仅响应右键菜单触发的翻译消息
 * 2. 按选区拆分为多个文本节点片段
 * 3. 跳过：纯数字、日期、URL、邮箱、纯标点/符号等无需翻译内容
 * 4. 逐段调用后台模型服务翻译为中文
 * 5. 每返回一个翻译结果，就立即替换对应文本，实现逐步替换效果
 * 6. 仅替换原位置的文本内容，不修改标签结构和属性
 */

const TRANSLATE_TARGET_LANGUAGE = "Chinese";
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
    const translatedTextCache = new Map();

    for (const segment of segments) {
      const { textNode, start, end, selectedPart, parentEl } = segment;
      const originalText = textNode.nodeValue || "";

      // 跳过不需要翻译的片段
      if (!shouldTranslateText(selectedPart)) {
        changedSegments.push({
          originalText: selectedPart,
          translatedText: selectedPart,
          skipped: true,
          reason: getSkipReason(selectedPart),
          tag: parentEl ? parentEl.tagName.toLowerCase() : null,
          href: getAnchorHref(parentEl),
          path: parentEl ? buildDomPath(parentEl) : null,
        });
        continue;
      }

      // 同一段文本如果后面再次出现，直接复用结果
      let translated = translatedTextCache.get(selectedPart);

      if (typeof translated !== "string") {
        translated = await translateTextViaBackground(selectedPart);
        translatedTextCache.set(selectedPart, translated);
      }

      if (typeof translated !== "string" || !translated.length) {
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

      // 让浏览器有机会先绘制，再处理下一段，视觉上更像“逐步替换”
      await nextFrame();
    }

    sel.removeAllRanges();

    console.log("已翻译并替换选区:", changedSegments);
    return changedSegments;
  } finally {
    isTranslatingSelection = false;
  }
}

function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/**
 * 判断文本是否需要翻译
 * 跳过：
 * - 空白
 * - 纯数字
 * - 日期
 * - URL
 * - 邮箱
 * - 纯标点/纯符号
 */
function shouldTranslateText(text) {
  if (typeof text !== "string") return false;

  const compact = text.trim();
  if (!compact) return false;

  const stripped = compact.replace(/\s+/g, "");
  if (!stripped) return false;

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
  if (isPurePunctuationOrSymbols(compact)) return "pure_punctuation_or_symbols";
  if (isLikelyEmail(compact)) return "email";
  if (isLikelyUrl(compact)) return "url";
  if (isLikelyDate(compact)) return "date";
  if (isNumericLike(compact)) return "numeric";

  return "unknown";
}

function isPurePunctuationOrSymbols(text) {
  return /^[\p{P}\p{S}]+$/u.test(text);
}

function isLikelyEmail(text) {
  // 足够实用的邮箱判断，避免把普通文本误判得太多
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(text);
}

function isLikelyUrl(text) {
  const t = text.trim();

  if (/^(https?:\/\/|ftp:\/\/|file:\/\/)/i.test(t)) {
    return true;
  }

  if (/^www\./i.test(t)) {
    return true;
  }

  // bare domain / domain+path
  if (/^[^\s@]+\.[^\s@]{2,}(?:\/\S*)?$/i.test(t)) {
    try {
      const normalized = t.includes("://") ? t : `https://${t}`;
      const url = new URL(normalized);
      return Boolean(url.hostname);
    } catch {
      return false;
    }
  }

  return false;
}

function isLikelyDate(text) {
  const t = text.trim();

  const datePatterns = [
    // 2026-05-26 / 2026/05/26 / 2026.05.26
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/,
    // 2026-05-26T10:00 / 2026-05-26 10:00:00Z
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}[T\s]\d{1,2}:\d{2}(:\d{2})?(?:Z|[+\-]\d{2}:?\d{2})?$/,
    // 2026年5月26日 / 2026年5月
    /^\d{4}年\d{1,2}月(?:\d{1,2}[日号]?)?$/,
    // 5月26日 / 5月
    /^\d{1,2}月(?:\d{1,2}[日号]?)?$/,
    // 26/05/2026 / 26-05-2026 / 05/26/2026
    /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/,
  ];

  return datePatterns.some((re) => re.test(t));
}

function isNumericLike(text) {
  const t = text.trim();
  if (!t) return false;

  // 纯数字，允许常见数字分隔符/货币/百分号/正负号
  // 不包含字母或汉字，避免把 "iPhone 15" 之类误判掉
  return /^[+\-−—]?(?:\p{N}|\d)[\p{N}\d,.\s:%/\\()（）￥$€£¥·+-]*$/u.test(t) &&
    !/[\p{L}\p{Script=Han}]/u.test(t);
}

/**
 * 调用后台翻译服务
 * 对应 background/service worker 中的 TRANSLATE_TEXT 入口
 */
function translateTextViaBackground(text) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "TRANSLATE_TEXT",
        text,
        targetLanguage: TRANSLATE_TARGET_LANGUAGE,
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

/**
 * 获取选区中每个文本节点的实际选中片段
 * 返回：
 * [
 *   {
 *     textNode,
 *     parentEl,
 *     start,
 *     end,
 *     selectedPart
 *   }
 * ]
 */
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

/**
 * 计算某个文本节点在当前选区中的起止位置
 */
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

/**
 * 获取父节点对应的 a 链接 href
 */
function getAnchorHref(parentEl) {
  if (!parentEl) return null;
  const anchor = parentEl.closest("a");
  return anchor ? anchor.href : null;
}

/**
 * 生成一个尽量清晰的 DOM 路径，方便调试
 */
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