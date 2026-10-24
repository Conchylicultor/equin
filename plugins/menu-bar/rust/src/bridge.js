// window.equinNative — the panel's bridge to equin-desktop. Injected into the
// "panel" window's main frame only (never an app window, never a sub-frame),
// and defined only on an equin page (http://<namespace>.localhost:9000); the
// commands are ACL-gated to that same window and origin
// (capabilities/panel-bridge.json), so a page this guard missed still could
// not call them. The contract the web side codes against (menu-bar/web's
// useNativeHost) — bump `version` in host_info on any breaking change.
(function () {
  if (!/^http:\/\/[a-z0-9-]+\.localhost:9000$/.test(window.location.origin)) return;
  if (window.top !== window) return;
  function invoke(cmd, args) {
    // Read at call time: Tauri's own IPC script defines it.
    return window.__TAURI_INTERNALS__.invoke(cmd, args);
  }
  function done() {
    return undefined;
  }
  var api = {
    hostInfo: function () {
      return invoke("host_info");
    },
    setAttention: function (on) {
      return invoke("set_attention", { on: on === true }).then(done);
    },
    notify: function (n) {
      return invoke("notify", {
        title: String(n.title),
        body: n.body === undefined ? null : String(n.body),
        tag: n.tag === undefined ? null : String(n.tag),
      }).then(done);
    },
    openUrl: function (url) {
      return invoke("open_url", { url: String(url) }).then(done);
    },
    launchApp: function (appId) {
      return invoke("launch_app", { appId: String(appId) }).then(done);
    },
    hidePanel: function () {
      return invoke("hide_panel").then(done);
    },
    setPanelHeight: function (px) {
      return invoke("set_panel_height", { px: Number(px) }).then(done);
    },
  };
  Object.defineProperty(window, "equinNative", {
    value: Object.freeze(api),
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();
