// window.equinWindow — an installed app window's bridge to equin-desktop: the
// powers a page of the app needs from the machine it runs on (today, dragging
// files out as real files). Injected into the "app" window's main frame only,
// and defined only on the window's origin (`__EQUIN_ORIGIN__`, filled by
// src/window.rs). This guard is a courtesy: the helper enforces it natively —
// the ACL grants the commands to that exact origin and window, and every
// command checks the page the window shows when it is called
// (src/commands.rs). The contract the web side codes against (menu-bar/core's
// EquinWindowBridge) — bump `version` in window_info on any breaking change.
(function () {
  var origin = __EQUIN_ORIGIN__;
  if (window.location.origin !== origin) return;
  if (window.top !== window) return;
  function invoke(cmd, args) {
    // Read at call time: Tauri's own IPC script defines it.
    return window.__TAURI_INTERNALS__.invoke(cmd, args);
  }
  var api = {
    hostInfo: function () {
      return invoke("window_info");
    },
    startFileDrag: function (paths) {
      return invoke("start_file_drag", { paths: Array.from(paths, String) });
    },
  };
  Object.defineProperty(window, "equinWindow", {
    value: Object.freeze(api),
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();
