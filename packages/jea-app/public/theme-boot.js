(function () {
  try {
    var stored = localStorage.getItem('jea.theme')
    var preference = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
    var dark = preference === 'dark' || (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.documentElement.dataset.themeReady = 'true'
  } catch (error) {
    document.documentElement.dataset.theme = 'light'
    document.documentElement.dataset.themeReady = 'true'
  }
})()
