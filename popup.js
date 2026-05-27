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
  targetLang.value = defaultTarget || 'Chinese';
}



async function translateText(text, tgtLang) {
  const settings = await chrome.storage.sync.get({
    apiBaseUrl: "http://localhost:1234/v1",
    modelName: "hy-mt2-1.8b",
    defaultTargetLanguage: "Chinese",
  });

  // ---- 本地语言检测 ----
  const detectedLang = LangDetect.detect(text);
  const tgtLabel = langLabel(tgtLang);

  // 源语言与目标语言相同，无需翻译
  if (detectedLang && detectedLang === tgtLang) {
    return {
      detectedLang: LangDetect.getNativeName(detectedLang),
      translatedText: text,
      sameLanguage: true,
    };
  }

  // ---- 纯翻译 prompt（不含语言检测） ----
  const prompt = [
    "You are a professional translation engine.",
    `Translate the following text into ${tgtLabel}.`,
    "Translate faithfully and naturally. Preserve meaning, tone, punctuation, formatting, HTML tags, and placeholders.",
    "Output ONLY the translated text, no extra commentary.",
  ].join("\n");

  const resp = await fetch(`${settings.apiBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
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
  const translated = data?.choices?.[0]?.message?.content?.trim() || text;

  return {
    detectedLang: detectedLang ? LangDetect.getNativeName(detectedLang) : '',
    translatedText: translated,
    sameLanguage: false,
  };
}

async function init() {
  const settings = await new Promise((res) => chrome.storage.sync.get({ defaultTargetLanguage: 'Chinese' }, res));
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
    const tgt = targetLang.value;
    const tgtLabel = langLabel(tgt);
    const { detectedLang, translatedText: result, sameLanguage } = await translateText(text, tgt);

    if (sameLanguage) {
      outputText.value = text;
      metaInfo.textContent = `原文本已是${detectedLang || tgtLabel}，无需翻译`;
    } else {
      outputText.value = result;
      const srcLabel = detectedLang || '未知';
      metaInfo.textContent = `已从${srcLabel}翻译为${tgtLabel}`;
    }
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
