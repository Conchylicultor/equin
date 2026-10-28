// The probe's attacker (src/probe.rs): evaluated natively in the panel's main
// frame once the pinned page has loaded — the stand-in for content that
// reached the panel. Each row tries one way to the bridge and reports what
// it got; the helper judges. `__EQUIN_PROBE__` = { otherOrigin, sameOrigin,
// newWindow } (filled by probe.rs). Results go back as `document.title`
// (`equin-probe:<json>`, one per row), the one channel that needs no bridge.
(async function () {
  var P = __EQUIN_PROBE__;
  window.addEventListener("error", function (e) {
    document.title = "equin-probe:" + JSON.stringify({ phase: "error", message: String(e.message) });
  });
  var WAIT = 2500;
  // Reports go out one at a time, spaced: WebKit coalesces title changes
  // that land together (and cuts a long title short — details are capped).
  var sent = Promise.resolve();
  function send(report) {
    sent = sent.then(function () {
      document.title = "equin-probe:" + JSON.stringify(report);
      return sleep(250);
    });
    return sent;
  }
  function row(id, outcome, detail) {
    void send({ phase: "row", id: id, outcome: outcome, detail: String(detail || "").slice(0, 300) });
  }
  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }
  function settle(p) {
    return Promise.race([
      p.then(
        function (v) {
          return { outcome: "answered", detail: JSON.stringify(v) };
        },
        function (e) {
          return { outcome: "rejected", detail: String(e) };
        },
      ),
      sleep(WAIT).then(function () {
        return { outcome: "silent", detail: "no reply in " + WAIT + " ms" };
      }),
    ]);
  }

  // 1. The pinned page itself: the one caller that must be answered.
  var main = await settle(window.equinNative.hostInfo());
  row("main-frame", main.outcome, main.detail);

  // 2. Frames whose own script tries the bridge through `top` and reports
  //    back by postMessage — a frame the panel refuses never reports.
  var attack =
    "<script>(async function(){var out={};" +
    "function rep(o){parent.postMessage({equinProbe:ROW,result:o},'*');}" +
    "try{var t=top;" +
    "var a=t.equinNative?t.equinNative.hostInfo():Promise.reject('no equinNative');" +
    "var b=t.__TAURI_INTERNALS__?t.__TAURI_INTERNALS__.invoke('host_info'):Promise.reject('no internals');" +
    "var r=await Promise.allSettled([a,b]);" +
    "rep({outcome:r.some(function(x){return x.status==='fulfilled'})?'answered':'rejected',detail:JSON.stringify(r)});" +
    "}catch(e){" +
    // An opaque frame cannot reach top: try the raw IPC with a guessed key.
    "try{var res=await fetch('ipc://localhost/host_info',{method:'POST',headers:{'Content-Type':'application/json','Tauri-Callback':'1','Tauri-Error':'2','Tauri-Invoke-Key':'guess'},body:'{}'});" +
    "rep({outcome:res.ok?'answered':'rejected',detail:'ipc '+res.status});" +
    "}catch(f){rep({outcome:'rejected',detail:String(e)+' / '+String(f)});}}" +
    "})();<\/script>";
  function frameRow(id, setup) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(outcome, detail) {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMessage);
        row(id, outcome, detail);
        resolve();
      }
      function onMessage(e) {
        if (e.data && e.data.equinProbe === id) finish(e.data.result.outcome, e.data.result.detail);
      }
      window.addEventListener("message", onMessage);
      var el = setup(attack.replace("ROW", JSON.stringify(id)));
      document.body.appendChild(el);
      setTimeout(function () {
        var detail = "frame never ran";
        try {
          // Same-origin frames: did the document arrive at all?
          var w = el.contentWindow;
          if (w) detail += " (location " + w.location.href + ")";
        } catch (e) {
          detail += " (cross-origin)";
        }
        finish("silent", detail);
      }, WAIT);
    });
  }
  function iframe(attrs) {
    return function (html) {
      var f = document.createElement("iframe");
      Object.keys(attrs).forEach(function (k) {
        f.setAttribute(k, attrs[k]);
      });
      if (!("src" in attrs)) f.srcdoc = html;
      return f;
    };
  }
  await frameRow("srcdoc-frame", iframe({}));
  await frameRow("same-origin-sandboxed-frame", iframe({ sandbox: "allow-scripts allow-same-origin" }));
  await frameRow("opaque-frame", iframe({ sandbox: "allow-scripts" }));

  // 3. Frames on a URL: did the document load? (A same-origin one is read
  //    back; another namespace's is judged by the helper's refusals.)
  async function urlFrame(id, make) {
    var el = make();
    document.body.appendChild(el);
    await sleep(WAIT);
    var href;
    try {
      var doc = el.contentDocument || (el.contentWindow && el.contentWindow.document);
      href = doc ? doc.location.href : "no document";
    } catch (e) {
      href = "cross-origin";
    }
    row(id, href === "about:blank" || href === "no document" ? "blank" : "loaded", href);
  }
  await urlFrame("same-origin-url-frame", function () {
    var f = document.createElement("iframe");
    f.src = P.sameOrigin + "?row=iframe";
    return f;
  });
  await urlFrame("object", function () {
    var o = document.createElement("object");
    o.type = "text/html";
    o.data = P.sameOrigin + "?row=object";
    return o;
  });
  await urlFrame("embed", function () {
    var o = document.createElement("embed");
    o.type = "text/html";
    o.src = P.sameOrigin + "?row=embed";
    return o;
  });
  await urlFrame("other-namespace-frame", function () {
    var f = document.createElement("iframe");
    f.src = P.otherOrigin + "/home/menu-bar?embed=1&row=other";
    return f;
  });

  // 4. The panel's own document moved to another route (no navigation).
  var home = location.href;
  history.pushState(null, "", "/agents");
  var moved = await settle(window.equinNative.hostInfo());
  row("pushstate-away", moved.outcome, moved.detail);
  history.replaceState(null, "", home);
  var back = await settle(window.equinNative.hostInfo());
  row("pushstate-back", back.outcome, back.detail);

  // 5. A new window: none may open (the helper hands it to the browser).
  var w = window.open(P.newWindow, "_blank");
  row("window-open", w ? "opened" : "none", w ? "a window object came back" : "null");

  // 6. Last — it would unload this page: send the panel to another namespace.
  await sent;
  await sleep(200);
  location.assign(P.otherOrigin + "/home/menu-bar?embed=1&row=navigate");
  await sleep(WAIT);
  await send({ phase: "stayed", href: location.href });
})().catch(function (e) {
  document.title = "equin-probe:" + JSON.stringify({ phase: "error", message: String(e && e.stack ? e.stack : e) });
});
