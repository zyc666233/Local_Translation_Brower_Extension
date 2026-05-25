/**
 * 获取当前鼠标选区对应的文本、标签、链接信息
 * 适合浏览器扩展 content script 使用
 */
function getSelectionDomInfo() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    return null;
  }

  const range = sel.getRangeAt(0);
  const selectedText = sel.toString();

  if (!selectedText || !selectedText.trim()) {
    return null;
  }

  const commonAncestor =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;

  if (!commonAncestor) {
    return null;
  }

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
      }
    }
  );

  const segments = [];
  const seen = new Set();

  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    const parentEl = textNode.parentElement;
    if (!parentEl) continue;

    // 取出该文本节点在选区中的实际片段
    const text = getSelectedPartOfTextNode(textNode, range);
    if (!text.trim()) continue;

    const tag = parentEl.tagName.toLowerCase();
    const anchor = parentEl.closest("a");

    const segment = {
      text,
      tag,
      href: anchor ? anchor.href : null,
      id: parentEl.id || null,
      className: typeof parentEl.className === "string" ? parentEl.className : null,
      path: buildDomPath(parentEl),
      element: parentEl
    };

    // 去重：同一个节点可能被重复命中
    const key = `${segment.path}::${segment.text}`;
    if (seen.has(key)) continue;
    seen.add(key);

    segments.push(segment);
  }

  const tags = [...new Set(segments.map(s => s.tag))];
  const anchorHrefs = [...new Set(segments.filter(s => s.href).map(s => s.href))];

  return {
    selectedText: selectedText.trim(),
    tags,
    hasLink: anchorHrefs.length > 0,
    anchorHrefs,
    segments
  };
}

/**
 * 获取某个文本节点在选区中的实际文本片段
 */
function getSelectedPartOfTextNode(textNode, range) {
  const fullText = textNode.nodeValue || "";
  let start = 0;
  let end = fullText.length;

  // 选区起点刚好落在这个文本节点里
  if (textNode === range.startContainer && textNode.nodeType === Node.TEXT_NODE) {
    start = range.startOffset;
  }

  // 选区终点刚好落在这个文本节点里
  if (textNode === range.endContainer && textNode.nodeType === Node.TEXT_NODE) {
    end = range.endOffset;
  }

  if (start < 0) start = 0;
  if (end > fullText.length) end = fullText.length;
  if (end < start) return "";

  return fullText.slice(start, end);
}

/**
 * 生成一个尽量清晰的 DOM 路径，方便你调试
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
        child => child.tagName === current.tagName
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

document.addEventListener("mouseup", () => {
  setTimeout(() => {
    const info = getSelectionDomInfo();
    if (!info) return;

    console.log("选中文本：", info.selectedText);
    console.log("标签列表：", info.tags);
    console.log("是否包含链接：", info.hasLink);
    console.log("链接地址：", info.anchorHrefs);
    console.log("分段信息：", info.segments);
  }, 0);
});