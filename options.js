const fields = {
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  modelName: document.getElementById("modelName"),
  defaultTargetLanguage: document.getElementById("defaultTargetLanguage"),
};

const saveBtn = document.getElementById("saveBtn");
const status = document.getElementById("status");

async function loadSettings() {
  const data = await chrome.storage.sync.get({
    apiBaseUrl: "http://localhost:1234/v1",
    modelName: "hy-mt2-1.8b",
    defaultTargetLanguage: "Chinese",
  });

  fields.apiBaseUrl.value = data.apiBaseUrl;
  fields.modelName.value = data.modelName;
  fields.defaultTargetLanguage.value = data.defaultTargetLanguage;
}

async function saveSettings() {
  await chrome.storage.sync.set({
    apiBaseUrl: fields.apiBaseUrl.value.trim(),
    modelName: fields.modelName.value.trim(),
    defaultTargetLanguage: fields.defaultTargetLanguage.value,
  });

  status.textContent = "已保存";
  setTimeout(() => (status.textContent = ""), 1200);
}

saveBtn.addEventListener("click", saveSettings);
loadSettings();
