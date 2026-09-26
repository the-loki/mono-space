chrome.runtime.onMessage.addListener((_message, _sender, sendResponse) => {
  const manifest = chrome.runtime.getManifest()
  sendResponse({ marker: 'sw-v1', manifestVersion: manifest.manifest_version, name: manifest.name })
  return true
})
