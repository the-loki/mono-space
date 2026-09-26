chrome.runtime.sendMessage({ cmd: 'hello' }).then((response) => {
  window.postMessage(
    { __monoSpaceExtension: true, payload: { ...response, href: location.href } },
    '*'
  )
})
