const fields = {
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  modelName: document.getElementById("modelName"),
  defaultTargetLanguage: document.getElementById("defaultTargetLanguage"),
  pageTranslateTargetForChinese: document.getElementById("pageTranslateTargetForChinese"),
  pageTranslateTargetForNonChinese: document.getElementById("pageTranslateTargetForNonChinese"),
};

const saveBtn = document.getElementById("saveBtn");
const status = document.getElementById("status");

async function loadSettings() {
  const data = await chrome.storage.sync.get({
    apiBaseUrl: "http://localhost:1234/v1",
    modelName: "qwen3.5-9b",
    defaultTargetLanguage: "English",
    pageTranslateTargetForChinese: "English",
    pageTranslateTargetForNonChinese: "Chinese",
  });

  fields.apiBaseUrl.value = data.apiBaseUrl;
  fields.modelName.value = data.modelName;
  fields.defaultTargetLanguage.value = data.defaultTargetLanguage;
  fields.pageTranslateTargetForChinese.value = data.pageTranslateTargetForChinese;
  fields.pageTranslateTargetForNonChinese.value = data.pageTranslateTargetForNonChinese;
}

async function saveSettings() {
  await chrome.storage.sync.set({
    apiBaseUrl: fields.apiBaseUrl.value.trim(),
    modelName: fields.modelName.value.trim(),
    defaultTargetLanguage: fields.defaultTargetLanguage.value,
    pageTranslateTargetForChinese: fields.pageTranslateTargetForChinese.value,
    pageTranslateTargetForNonChinese: fields.pageTranslateTargetForNonChinese.value,
  });

  status.textContent = "已保存";
  setTimeout(() => (status.textContent = ""), 1200);
}

saveBtn.addEventListener("click", saveSettings);
loadSettings();
