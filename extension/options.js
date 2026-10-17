const language = document.querySelector('#language');
const model = document.querySelector('#model');
const segmentation = document.querySelector('#segmentation');
const status = document.querySelector('#status');
const engine = document.querySelector('#engine');
function updateEngine() {
  const tesseract = engine.value === 'tesseract';
  document.querySelector('#tesseract-settings').hidden = !tesseract;
  document.querySelector('#tesseract-settings').disabled = !tesseract;
  document.querySelector('#paddle-info').hidden = tesseract;
}
engine.addEventListener('change', updateEngine);
chrome.storage.local.get({ language: 'chi_sim+eng', segmentation: '3', model: 'best', engine: 'paddle' }).then(settings => {
  engine.value = settings.engine === 'tesseract' ? 'tesseract' : 'paddle';
  model.value = settings.model === 'fast' ? 'fast' : 'best';
  language.value = settings.language;
  segmentation.value = settings.segmentation;
  updateEngine();
}).catch(error => { status.textContent = `读取失败：${error.message}`; });
document.querySelector('#settings').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await chrome.storage.local.set({ language: language.value, segmentation: segmentation.value, model: model.value, engine: engine.value });
    status.textContent = '已保存，下次提取时生效。';
  } catch (error) { status.textContent = `保存失败：${error.message}`; }
});
