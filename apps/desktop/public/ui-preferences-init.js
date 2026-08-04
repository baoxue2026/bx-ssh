(function () {
  var themeMode = "system";
  var language = "zh-CN";

  try {
    var storedTheme = localStorage.getItem("bx-ssh.theme-mode");
    if (
      storedTheme === "light" ||
      storedTheme === "dark" ||
      storedTheme === "system"
    ) {
      themeMode = storedTheme;
    }

    var storedLanguage = localStorage.getItem("bx-ssh.language");
    if (storedLanguage === "zh-CN" || storedLanguage === "en-US") {
      language = storedLanguage;
    }
  } catch (_) {
    // Storage can be unavailable in hardened WebView profiles.
  }

  var systemDark = window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
  var resolvedTheme =
    themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;
  var root = document.documentElement;
  root.dataset.theme = resolvedTheme;
  root.dataset.themeMode = themeMode;
  root.style.colorScheme = resolvedTheme;
  root.lang = language;
})();
