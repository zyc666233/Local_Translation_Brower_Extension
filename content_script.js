/**
 * content_scripts
 * 功能：
 * 1. 鼠标选中一段文本后，按文本节点拆分
 * 2. 逐段调用后台翻译服务，翻译为中文
 * 3. 仅替换选区内的文本内容，不修改标签结构和属性
 *
 * 依赖：
 * - background/service worker 中已实现 TRANSLATE_TEXT 消息处理
 */

const TRANSLATE_TARGET_LANGUAGE = "Chinese";
let isTranslatingSelection = false;

/**
 * 鼠标松开后自动处理当前选区
 * 如果你只想通过右键菜单触发，可以删掉这个监听器
 */
document.addEventListener("mouseup", () => {
  setTimeout(() => {
    translateCurrentSelectionInPlace().catch((err) => {
      console.error("翻译选区失败:", err);
    });
  }, 0);
});

/**
 * 可选：支持来自 background 的主动触发
 * 例如右键菜单点击后，background 发消息给 content script
 */
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
 * 翻译当前选区，并将翻译结果原位写回 DOM
 */
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
    // 先对同样的文本去重，避免重复请求
    const uniqueTexts = [...new Set(
      segments
        .map((s) => s.selectedPart)
        .filter((text) => typeof text === "string" && text.trim())
    )];

    const translatedMap = new Map();

    for (const text of uniqueTexts) {
      const translated = await translateTextViaBackground(text);
      translatedMap.set(text, translated);
    }

    const changedSegments = [];

    for (const segment of segments) {
      const { textNode, start, end, selectedPart, parentEl } = segment;
      const originalText = textNode.nodeValue || "";

      const translated = translatedMap.get(selectedPart);
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
        tag: parentEl ? parentEl.tagName.toLowerCase() : null,
        href: getAnchorHref(parentEl),
        path: parentEl ? buildDomPath(parentEl) : null,
      });
    }

    // 清除选区，避免页面上还残留蓝色高亮
    sel.removeAllRanges();

    console.log("已翻译并替换选区:", changedSegments);

    return changedSegments;
  } finally {
    isTranslatingSelection = false;
  }
}

/**
 * 调用后台翻译服务
 * 对应你上传的 background/service worker 中的 TRANSLATE_TEXT 入口
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