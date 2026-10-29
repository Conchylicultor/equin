// The window probe's navigator (src/probe_window.rs): evaluated natively in an
// app window's main frame once its page has loaded — the stand-in for app code
// (or content it shows) that tries to take the window off its namespace. Each
// row tries one way; the helper judges from what its gate decided and what it
// handed off. `__EQUIN_PROBE__` = { foreign, other, content, home } (filled by
// probe_window.rs). Results go back as `document.title` (`equin-probe:<json>`),
// the one channel that needs no bridge.
(async function () {
  var P = __EQUIN_PROBE__;
  // Spaced past the hand-off gate's refill (3 s), so each row's hand-off is
  // its own and only the burst row is collapsed.
  var STEP = 3300;
  var sent = Promise.resolve();
  function send(report) {
    sent = sent.then(function () {
      document.title = "equin-probe:" + JSON.stringify(report);
      return sleep(250);
    });
    return sent;
  }
  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }
  async function row(id, act) {
    var before = location.href;
    act();
    await sleep(STEP);
    await send({ phase: "row", id: id, outcome: location.href === before ? "stayed" : "moved", detail: location.href });
  }
  function foreign(id) {
    return P.foreign + "/" + id;
  }

  await row("link-click", function () {
    var a = document.createElement("a");
    a.href = foreign("link-click");
    document.body.appendChild(a);
    a.click();
  });
  await row("location-assign", function () {
    location.assign(foreign("location-assign"));
  });
  await row("location-replace", function () {
    location.replace(foreign("location-replace"));
  });
  await row("form-post", function () {
    var f = document.createElement("form");
    f.method = "POST";
    f.action = foreign("form-post");
    document.body.appendChild(f);
    f.submit();
  });
  await row("other-namespace", function () {
    location.assign(P.other + "/home?row=other-namespace");
  });
  await row("frames", function () {
    [P.content + "/frame?row=content-frame", foreign("foreign-frame")].forEach(function (src) {
      var f = document.createElement("iframe");
      f.src = src;
      document.body.appendChild(f);
    });
  });
  await row("burst", function () {
    for (var i = 0; i < 30; i++) {
      window.open(foreign("burst-open-" + i), "_blank");
      location.assign(foreign("burst-assign-" + i));
    }
  });

  // Last — it unloads this page: an in-namespace route, which must load.
  await sent;
  await send({ phase: "leaving" });
  location.assign(P.home);
})().catch(function (e) {
  document.title = "equin-probe:" + JSON.stringify({ phase: "error", message: String(e && e.stack ? e.stack : e) });
});
