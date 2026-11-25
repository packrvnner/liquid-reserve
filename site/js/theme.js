// Runs before first paint: apply the theme (dark is the default).
// ?theme=light or ?theme=dark in the URL overrides the saved choice for that visit.
(function () {
  try {
    var q = new URLSearchParams(location.search).get("theme");
    var t = q === "light" || q === "dark" ? q : localStorage.getItem("lr-theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}
})();
