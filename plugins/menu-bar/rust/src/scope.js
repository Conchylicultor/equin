// An installed app's window keeps to its scope (src/window.rs: its namespace's
// origin, base ""). Main frame only, no IPC: an in-page navigation out of the
// scope — a link click, or the SPA's own pushState — becomes `window.open(url)`, which the native
// new-window handler hands to the installed app owning the URL, else the
// default browser. `__EQUIN_SCOPE__` is replaced with { origin, base }.
(function () {
  if (window.top !== window) return;
  var scope = __EQUIN_SCOPE__;
  function resolve(href) {
    try {
      return new URL(String(href), window.location.href);
    } catch (e) {
      return null;
    }
  }
  function outside(u) {
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return false;
    if (u.origin !== scope.origin) return true;
    if (scope.base === "") return false;
    return !(u.pathname === scope.base || u.pathname.indexOf(scope.base + "/") === 0);
  }
  function handOff(u) {
    window.open(u.href, "_blank");
  }
  // Capture on the document: ahead of any router's own click handling.
  document.addEventListener(
    "click",
    function (e) {
      if (e.defaultPrevented || e.button !== 0) return;
      var el = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!el) return;
      var u = resolve(el.href);
      if (!outside(u)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      handOff(u);
    },
    true,
  );
  // A router's push to another app: let it land, hand the URL off, step back
  // (the router restores the in-app route on popstate). A replace cannot be
  // stepped back from, so it is refused.
  var push = history.pushState;
  var replace = history.replaceState;
  history.pushState = function (state, title, url) {
    var u = url == null ? null : resolve(url);
    push.apply(this, arguments);
    if (outside(u)) {
      handOff(u);
      history.back();
    }
  };
  history.replaceState = function (state, title, url) {
    var u = url == null ? null : resolve(url);
    if (outside(u)) {
      handOff(u);
      return;
    }
    return replace.apply(this, arguments);
  };
})();
