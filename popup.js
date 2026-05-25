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
  targetLang.value = defaultTarget || 'English';
}



async function translateText(text, tgtLang) {
  const settings = await chrome.storage.sync.get({
    apiBaseUrl: "http://localhost:1234/v1",
    modelName: "qwen3.5-9b",
    defaultTargetLanguage: "English",
  });

  const tgtLabel = langLabel(tgtLang);

  const prompt = [
    "You are a professional translation engine.",
    "First, detect the source language of the input.",
    `If the source language is the same as the target language (${tgtLabel}), copy the input unchanged as the translation.`,
    "Output ONLY a valid JSON object (no markdown, no extra text) with exactly these three fields:",
    `"sourceLanguage": the source language name in its own native form (must be one of: English, 中文, Français, Deutsch, 日本語, 한국어, Русский)`,
    `"translation": the translated text (or original if source equals target)`,
    `"sameLanguage": true if source language equals ${tgtLabel}, false otherwise`,
  ].join('\n');

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
  const raw = data?.choices?.[0]?.message?.content?.trim() || '';

  // Parse JSON from response, handling possible markdown code blocks
  let jsonStr = raw;
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      detectedLang: parsed.sourceLanguage || '',
      translatedText: parsed.translation || text,
      sameLanguage: !!parsed.sameLanguage,
    };
  } catch {
    // Fallback: if JSON parsing fails, treat entire response as translation
    return { detectedLang: '', translatedText: raw, sameLanguage: false };
  }
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
