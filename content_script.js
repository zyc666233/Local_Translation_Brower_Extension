/**
 * content_scripts
 * 功能：
 * 1. 仅响应右键菜单触发的翻译消息
 * 2. 按选区拆分为多个文本节点片段
 * 3. 先过滤纯数字/纯符号片段
 * 4. 将需要翻译的片段调用后台模型服务翻译为中文
 * 5. 仅替换原位置的文本内容，不修改标签结构和属性
 *
 * 依赖：
 * - background/service worker 中已实现 TRANSLATE_TEXT 消息处理
 * - 右键菜单点击后，background 会发送 TRANSLATE_SELECTION 到当前标签页
 */

const TRANSLATE_TARGET_LANGUAGE = "Chinese";
let isTranslatingSelection = false;

/**
 * 仅响应来自 background 的右键菜单触发消息
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
    // 先筛出需要翻译的片段，并去重，避免重复请求模型
    const translatableTexts = [
      ...new Set(
        segments
          .map((s) => s.selectedPart)
          .filter((text) => shouldTranslateText(text))
      ),
    ];

    const translatedMap = new Map();

    for (const text of translatableTexts) {
      const translated = await translateTextViaBackground(text);
      translatedMap.set(text, translated);
    }

    const changedSegments = [];

    for (const segment of segments) {
      const { textNode, start, end, selectedPart, parentEl } = segment;
      const originalText = textNode.nodeValue || "";

      // 纯数字/纯符号：不翻译，直接保留原文
      if (!shouldTranslateText(selectedPart)) {
        changedSegments.push({
          originalText: selectedPart,
          translatedText: selectedPart,
          skipped: true,
          reason: "pure_number_or_symbol",
          tag: parentEl ? parentEl.tagName.toLowerCase() : null,
          href: getAnchorHref(parentEl),
          path: parentEl ? buildDomPath(parentEl) : null,
        });
        continue;
      }

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
        skipped: false,
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
 * 判断文本是否需要翻译
 * 规则：
 * - 空白不翻译
 * - 纯数字不翻译
 * - 纯符号不翻译
 *
 * 说明：
 * 这里采用较保守的判断方式，只跳过明显不需要翻译的片段。
 * 比如 "123"、"！！"、"—"、"%%%" 会被跳过；
 * 像 "3.14"、"2026-05-26" 这类带分隔符的内容，仍会进入翻译流程。
 */
function shouldTranslateText(text) {
  if (typeof text !== "string") return false;

  const compact = text.trim();
  if (!compact) return false;

  // 去掉空白后再判断，避免 "   123   "、" ！！ " 这种情况
  const stripped = compact.replace(/\s+/g, "");
  if (!stripped) return false;

  // 纯数字
  if (/^[\p{N}]+$/u.test(stripped)) {
    return false;
  }

  // 纯符号 / 标点
  if (/^[\p{P}\p{S}]+$/u.test(stripped)) {
    return false;
  }

  return true;
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