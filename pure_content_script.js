// pure_content_script.js
// Minimal: on right-click translate scope (nearest block ancestor) by replacing only text nodes' content.

let _savedRange = null;

document.addEventListener('contextmenu', (e) => {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && sel.toString().trim()) {
    _savedRange = sel.getRangeAt(0).cloneRange();
  } else {
    _savedRange = null;
  }
}, true);

function findScopeElement(range) {
  if (!range) return document.body;
  let node = range.commonAncestorContainer;
  if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
  let el = node;
  const blockTags = new Set(['div','p','article','section','main','header','footer','td','th','li','ul','ol','table','blockquote','pre']);
  while (el && el !== document.body) {
    const tag = el.tagName && el.tagName.toLowerCase();
    const display = getComputedStyle(el).display;
    if (blockTags.has(tag) || ['block','flex','grid','table'].includes(display)) {
      return el;
    }
    el = el.parentElement;
  }
  return document.body;
}

function collectTextNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName && parent.tagName.toLowerCase();
      if (['script','style','noscript','textarea','input','option','select'].includes(tag)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let cur;
  while ((cur = walker.nextNode())) nodes.push(cur);
  return nodes;
}

const SEG_RE = /([\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]+|[^\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]+)/g;
function splitSegments(text) {
  const matches = text.matchAll(SEG_RE);
  const segs = [];
  for (const m of matches) segs.push(m[0]);
  return segs;
}

const NEEDS_TRANSLATE_RE = /[A-Za-z0-9\u00C0-\u024F]/;
function isTranslatableSegment(seg) {
  const s = seg.trim();
  if (!s) return false;
  if (/^[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]+$/.test(s)) return false;
  return NEEDS_TRANSLATE_RE.test(s);
}

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(err);
      resolve(res);
    });
  });
}

async function translateSegments(segments) {
  if (!segments || segments.length === 0) return [];
  const resp = await sendMessage({ type: 'TRANSLATE_BATCH', segments, targetLanguage: 'Chinese' });
  if (!resp || !resp.ok) throw new Error(resp?.error || 'Translation failed');
  return resp.translations || [];
}

function showToast(msg, timeout = 1200) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;z-index:2147483647;top:10px;right:10px;padding:8px 12px;background:rgba(0,0,0,0.75);color:white;border-radius:6px;font-size:12px;';
  document.documentElement.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity 300ms'; t.style.opacity = '0'; setTimeout(()=>t.remove(), 300); }, timeout);
}

async function handleTranslateSelection(selectedTextFromBg) {
  let range = _savedRange;
  _savedRange = null;
  if (!range) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && sel.toString().trim()) {
      range = sel.getRangeAt(0).cloneRange();
    } else {
      showToast('未检测到选中文本');
      return;
    }
  }

  const scope = findScopeElement(range);
  const textNodes = collectTextNodes(scope);

  const uniqueSegs = [];
  const segIndex = new Map();
  const nodeSegments = [];
  for (const node of textNodes) {
    const segs = splitSegments(node.nodeValue);
    nodeSegments.push(segs);
    for (const s of segs) {
      if (!isTranslatableSegment(s)) continue;
      if (!segIndex.has(s)) {
        segIndex.set(s, uniqueSegs.length);
        uniqueSegs.push(s);
      }
    }
  }

  if (uniqueSegs.length === 0) {
    showToast('未找到需要翻译的非中文文本');
    return;
  }

  try {
    showToast('翻译中…', 3000);
    const translations = await translateSegments(uniqueSegs);
    const transMap = new Map();
    for (let i = 0; i < uniqueSegs.length; i++) {
      transMap.set(uniqueSegs[i], translations[i] ?? uniqueSegs[i]);
    }

    for (let i = 0; i < textNodes.length; i++) {
      const node = textNodes[i];
      const segs = nodeSegments[i];
      let changed = false;
      const rebuilt = segs.map(s => {
        if (transMap.has(s) && isTranslatableSegment(s)) {
          changed = true;
          return transMap.get(s);
        }
        return s;
      }).join('');
      if (changed) node.nodeValue = rebuilt;
    }
    showToast('翻译完成');
  } catch (err) {
    console.error('translate error', err);
    showToast('翻译失败 (查看控制台)');
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'TRANSLATE_SELECTION') {
    handleTranslateSelection(msg.text || '');
  }
});
