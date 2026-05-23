const inputText = document.getElementById("inputText");
const outputText = document.getElementById("outputText");
const translateBtn = document.getElementById("translateBtn");
const copyBtn = document.getElementById("copyBtn");
const sourceLang = document.getElementById("sourceLang");
const targetLang = document.getElementById("targetLang");
const metaInfo = document.getElementById("metaInfo");


const LANGS = [
  { value: 'auto', label: '自动检测' },
  { value: 'Chinese', label: '中文' },
  { value: 'English', label: 'English' },
  { value: 'French', label: 'Français' },
  { value: 'German', label: 'Deutsch' },
  { value: 'Japanese', label: '日本語' },
  { value: 'Korean', label: '한국어' },
  { value: 'Russian', label: 'Русский' },
];

function langLabel(value) {
  const found = LANGS.find(l => l.value === value);
  return found ? found.label : value;
}

function isChineseText(text) {
  const cleaned = (text || "").trim();
  if (!cleaned) return false;
  const chineseChars = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (cleaned.match(/[A-Za-z\u00C0-\u024F\u0400-\u04FF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
  return chineseChars >= Math.max(2, letters);
}

function detectLangBetter(text) {
  const cleaned = (text || "").trim();
  if (!cleaned) return 'auto';

  // Quick script checks for non-Latin scripts
  if (/[\u4e00-\u9fff]/.test(cleaned)) return 'Chinese';
  if (/[\u3040-\u30ff]/.test(cleaned)) return 'Japanese';
  if (/[\uac00-\ud7af]/.test(cleaned)) return 'Korean';
  if (/[\u0400-\u04FF]/.test(cleaned)) return 'Russian';

  const normalized = cleaned.toLowerCase();
  // Split common contractions like j'aime -> j aime so parts are tokenized individually
  const pre = normalized.replace(/([a-z\u00c0-\u024f])'([a-z\u00c0-\u024f])/gi, '$1 $2');

  // Tokenize words (apostrophes already handled)
  const words = pre.match(/[a-z\u00c0-\u024fœæß]+/gi) || [];

  const ENG_WORDS = new Set(['the','and','is','to','of','in','a','that','it','for','on','are','with','as','be','this','by','not','or','from','at','have','has','was','were','but','an','which','you','he','she','they','we','i','me','my','your','his','her','their','do','does','did','will','can','may','should']);
  const FR_WORDS = new Set(['le','la','les','de','du','des','un','une','et','est','en','pour','pas','que','qui','sur','avec','dans','ce','cette','ces','au','aux','comme','mais','plus','ou','si','son','ses','mon','ma','mes','ne','ni','quoi','où','donc','être','avoir','je','tu','il','elle','on','nous','vous','oui','non','bonjour','salut','merci','svp','s\'il','aujourd','aujourd\'hui','bien','très','tout','tous','toutes','parce','pourquoi','comment','quand','quel','quelle','chez','entre','après','avant','depuis','encore','toujours','jamais','pouvoir','faire','aller','dire','voir','venir','prendre','vouloir','aime','aimer','aimes','aimons','aiment','veux','veut','voudrais','veux','suis','es','sommes','êtes','sont','ai','as','a','avons','avez','ont']);
  const DE_WORDS = new Set(['der','die','das','und','ist','nicht','von','zu','mit','den','ein','eine','als','auch','für','auf','ich','du','er','sie','es','wir','ihr','in','dem','des','am','im','an','zum','zur','über','noch','mehr','sein','seine']);

  let scores = { English: 0, French: 0, German: 0 };

  for (const token of words) {
    if (!token) continue;
    // handle single-letter French contraction 'j' -> 'je'
    if (token === 'j') { scores.French++; continue; }
    const w = token.replace(/^'+|'+$/g, '');
    if (!w) continue;
    if (ENG_WORDS.has(w)) scores.English++;
    if (FR_WORDS.has(w)) scores.French++;
    if (DE_WORDS.has(w)) scores.German++;
  }

  // Accent boosts: strong signal for French/German
  const frenchAccents = (normalized.match(/[éèêàçùâôîûëïÿœæ]/gi) || []).length;
  const germanAccents = (normalized.match(/[äöüßẞ]/gi) || []).length;
  const apostrophes = (normalized.match(/'/g) || []).length;
  scores.French += frenchAccents * 3;
  scores.German += germanAccents * 3;
  // apostrophes slightly favor French (French uses many contractions)
  scores.French += apostrophes;

  // Direct French hints (single-word cues)
  const frenchHints = ['bonjour','merci','svp','aujourd','s\'il','salut','monsieur','madame','mademoiselle','oui','non'];
  for (const t of frenchHints) {
    if (normalized.includes(t)) { scores.French += 5; break; }
  }

  const maxScore = Math.max(scores.English, scores.French, scores.German);
  if (maxScore > 0) {
    // require a small margin to prefer a language
    if (scores.French >= scores.English + 1 && scores.French >= scores.German) return 'French';
    if (scores.German >= scores.English + 1 && scores.German >= scores.French) return 'German';
    if (scores.English >= scores.French + 1 && scores.English >= scores.German) return 'English';
  }

  // accent fallbacks
  if (frenchAccents > 0) return 'French';
  if (germanAccents > 0) return 'German';

  // single-token special cases
  if (words.length === 1) {
    const single = words[0].replace(/^'+|'+$/g, '');
    if (frenchHints.includes(single)) return 'French';
  }

  // final fallback
  if (/[A-Za-z]/.test(cleaned)) return 'English';
  return 'auto';
}

function detectLanguage(text) {
  // backward-compatible alias
  return detectLangBetter(text);
}

async function detectLanguageAuto(text) {
  if (window.detectLanguageClD3) {
    try {
      const r = window.detectLanguageClD3(text);
      if (r && r.language && r.language !== 'und') {
        const map = { en: 'English', fr: 'French', de: 'German', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ru: 'Russian' };
        return map[r.language] || detectLangBetter(text);
      }
    } catch (e) {
      console.error('cld3 detect error', e);
    }
  }
  return detectLangBetter(text);
}

function populateLangSelects(defaultTarget) {
  sourceLang.innerHTML = '';
  targetLang.innerHTML = '';

  // 原语言只保留"自动检测"
  const autoOpt = document.createElement('option');
  autoOpt.value = 'auto';
  autoOpt.textContent = '自动检测';
  sourceLang.appendChild(autoOpt);

  for (const l of LANGS) {
    if (l.value !== 'auto') {
      const opt2 = document.createElement('option');
      opt2.value = l.value;
      opt2.textContent = l.label;
      targetLang.appendChild(opt2);
    }
  }

  sourceLang.value = 'auto';
  targetLang.value = defaultTarget || 'English';
}



async function translateText(text, srcLang, tgtLang) {
  const settings = await chrome.storage.sync.get({
    apiBaseUrl: "http://localhost:1234/v1",
    modelName: "qwen3.5-9b",
    defaultTargetLanguage: "English",
    pageTranslateTargetForChinese: "English",
    pageTranslateTargetForNonChinese: "Chinese",
  });

  const detectedLang = await detectLanguageAuto(text);

  // If selected source lang differs from detected, auto-switch
  if (srcLang !== 'auto' && srcLang !== detectedLang) {
    sourceLang.value = detectedLang;
    srcLang = detectedLang;
  }

  const sourcePart = srcLang && srcLang !== 'auto' ? ` from ${srcLang}` : '';
  const prompt = [
    "You are a professional translation engine.",
    "Translate faithfully and naturally.",
    "Output only the translated text.",
    "If the input is already in the target language, output it unchanged.",
    `Translate the input${sourcePart} into ${tgtLang}.`,
  ].join(' ');

  const resp = await fetch(`${settings.apiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.modelName,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: text },
      ],
      temperature: 0,
      stream: false,
    }),
  });

  if (!resp.ok) {
    throw new Error(await resp.text());
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

async function init() {
  const settings = await new Promise((res) => chrome.storage.sync.get({ defaultTargetLanguage: 'English' }, res));
  populateLangSelects(settings.defaultTargetLanguage);
}

init();

translateBtn.addEventListener("click", async () => {
  const text = inputText.value.trim();
  if (!text) {
    outputText.value = "";
    return;
  }

  translateBtn.disabled = true;
  translateBtn.textContent = "翻译中...";

  try {
    const detectedLang = await detectLanguageAuto(text);

    let srcSelected = sourceLang.value;
    let src;
    if (srcSelected === 'auto') {
      // keep UI as auto, but use detected language for translation
      src = detectedLang;
    } else {
      // user picked specific source: show detected language after clicking
      sourceLang.value = detectedLang;
      src = detectedLang;
    }

    const tgt = targetLang.value;

    // 本地快速判断：如果检测到的语言与目标语言一致，无需调用大模型
    if (src === tgt) {
      outputText.value = text;
      metaInfo.textContent = `原文本已是${langLabel(tgt)}，无需翻译`;
      translateBtn.disabled = false;
      translateBtn.textContent = "翻译";
      return;
    }

    const result = await translateText(text, src, tgt);
    outputText.value = result;
    metaInfo.textContent = `已从${langLabel(src)}翻译为${langLabel(tgt)}`;
  } catch (err) {
    outputText.value = `错误：${err.message}`;
  } finally {
    translateBtn.disabled = false;
    translateBtn.textContent = "翻译";
  }
});

copyBtn.addEventListener("click", async () => {
  const text = outputText.value || "";
  if (!text) return;
  await navigator.clipboard.writeText(text);
  copyBtn.textContent = "已复制";
  setTimeout(() => (copyBtn.textContent = "复制结果"), 1200);
});

document.getElementById("settingsIconBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
