/* =======================================================================
 * preview.js — Builds the preview <iframe> document and manages sizing.
 *
 * Key idea for HIGH QUALITY: the iframe renders at the *full* export
 * resolution (e.g. 1920x1080). The visible preview is just a CSS-scaled
 * view of it, so `innerWidth/innerHeight` inside the user's code equal the
 * real export size and every captured frame is at native resolution.
 *
 * For SMOOTH / frame-accurate export we can inject a virtual-clock harness
 * that overrides requestAnimationFrame / performance.now / Date / timers so
 * the recorder can step time deterministically.
 *
 * Exposes a global `Preview` object.
 * ===================================================================== */
(function () {
  "use strict";

  let iframe, frameEl, stageEl, dimReadout;
  let renderW = 1920;
  let renderH = 1080;

  /* -- The harness injected into the iframe when deterministic capture is on -- */
  function harnessScript() {
    return (
      "(function(){\n" +
      "  var vt = 0;                       // virtual time (ms)\n" +
      "  var epoch = Date.now();           // real epoch base\n" +
      "  var rafCbs = [], rafId = 1;\n" +
      "  var timers = [], timerId = 1;\n" +
      "  var OrigDate = Date;\n" +
      "  try { performance.now = function(){ return vt; }; } catch(e){}\n" +
      "  function FakeDate(y){\n" +
      "    if(arguments.length===0) return new OrigDate(epoch + vt);\n" +
      "    var a=[null].concat([].slice.call(arguments));\n" +
      "    return new (Function.prototype.bind.apply(OrigDate, a));\n" +
      "  }\n" +
      "  FakeDate.now = function(){ return epoch + vt; };\n" +
      "  FakeDate.UTC = OrigDate.UTC; FakeDate.parse = OrigDate.parse;\n" +
      "  FakeDate.prototype = OrigDate.prototype;\n" +
      "  window.Date = FakeDate;\n" +
      "  window.requestAnimationFrame = function(cb){ var id=rafId++; rafCbs.push({id:id,cb:cb}); return id; };\n" +
      "  window.webkitRequestAnimationFrame = window.requestAnimationFrame;\n" +
      "  window.cancelAnimationFrame = function(id){ rafCbs = rafCbs.filter(function(r){return r.id!==id;}); };\n" +
      "  var _st = window.setTimeout, _si = window.setInterval;\n" +
      "  window.setTimeout = function(fn, delay){ var args=[].slice.call(arguments,2); var id=timerId++; timers.push({id:id,time:vt+(+delay||0),fn:fn,args:args,interval:null}); return id; };\n" +
      "  window.setInterval = function(fn, delay){ var args=[].slice.call(arguments,2); var id=timerId++; timers.push({id:id,time:vt+(+delay||16),fn:fn,args:args,interval:(+delay||16)}); return id; };\n" +
      "  window.clearTimeout = function(id){ timers = timers.filter(function(t){return t.id!==id;}); };\n" +
      "  window.clearInterval = window.clearTimeout;\n" +
      "  // Advance the virtual clock to targetMs, firing due timers then one rAF tick.\n" +
      "  window.__vStep = function(targetMs){\n" +
      "    var guard = 0;\n" +
      "    while(true){\n" +
      "      var next=null;\n" +
      "      for(var i=0;i<timers.length;i++){ if(timers[i].time<=targetMs && (!next || timers[i].time<next.time)) next=timers[i]; }\n" +
      "      if(!next) break;\n" +
      "      vt = next.time;\n" +
      "      if(next.interval==null){ timers = timers.filter(function(x){return x.id!==next.id;}); }\n" +
      "      else { next.time = next.time + next.interval; }\n" +
      "      try { next.fn.apply(null, next.args); } catch(e){ console.error(e); }\n" +
      "      if(++guard>200000) break;\n" +
      "    }\n" +
      "    vt = targetMs;\n" +
      "    var cbs = rafCbs; rafCbs = [];\n" +
      "    for(var j=0;j<cbs.length;j++){ try { cbs[j].cb(vt); } catch(e){ console.error(e); } }\n" +
      "  };\n" +
      "  window.__vReady = true;\n" +
      "})();\n"
    );
  }

  function buildDoc(project, deterministic) {
    const head =
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      "<style>html,body{margin:0;padding:0;}\n" +
      (project.css || "") +
      "</style></head><body>";

    const harness = deterministic ? "<script>" + harnessScript() + "<\/script>" : "";

    // Order: body HTML (may include CDN <script> tags) -> harness -> user JS.
    // Harness must run before user JS so overrides apply, but after CDN libs
    // are requested. CDN <script src> tags execute in document order, so libs
    // referenced in the HTML are ready before the user JS block runs.
    const body =
      (project.html || "") +
      harness +
      '<script>\ntry{\n' +
      (project.js || "") +
      "\n}catch(e){console.error(e);document.title='ERROR: '+e.message;}\n<\/script>";

    return head + body + "</body></html>";
  }

  function applyLayout() {
    if (!iframe) return;
    // Set iframe to the true render resolution.
    iframe.style.width = renderW + "px";
    iframe.style.height = renderH + "px";

    // Compute the display box that fits inside the stage (minus padding).
    const stageRect = stageEl.getBoundingClientRect();
    const padding = 36;
    const availW = Math.max(80, stageRect.width - padding);
    const availH = Math.max(80, stageRect.height - padding);
    const scale = Math.min(availW / renderW, availH / renderH, 1);

    const dispW = Math.round(renderW * scale);
    const dispH = Math.round(renderH * scale);

    frameEl.style.width = dispW + "px";
    frameEl.style.height = dispH + "px";

    iframe.style.transformOrigin = "top left";
    iframe.style.transform = "scale(" + scale + ")";

    if (dimReadout) {
      dimReadout.textContent =
        renderW + " × " + renderH + "  (" + Math.round(scale * 100) + "% view)";
    }
  }

  function loadDoc(srcdoc, waitForHarness) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve(iframe.contentWindow);
      };
      iframe.onload = () => {
        if (!waitForHarness) {
          // give the browser a tick to lay out / run sync scripts
          setTimeout(done, 30);
          return;
        }
        // Wait for the deterministic harness to be ready.
        const started = Date.now();
        const poll = () => {
          let ready = false;
          try {
            ready = !!iframe.contentWindow.__vReady;
          } catch (e) {
            ready = false;
          }
          if (ready || Date.now() - started > 4000) done();
          else setTimeout(poll, 16);
        };
        poll();
      };
      iframe.srcdoc = srcdoc;
    });
  }

  const Preview = {
    init() {
      iframe = document.getElementById("previewIframe");
      frameEl = document.getElementById("previewFrame");
      stageEl = document.getElementById("previewStage");
      dimReadout = document.getElementById("dimReadout");
      window.addEventListener("resize", () => applyLayout());
    },

    setRenderSize(w, h) {
      renderW = Math.max(2, Math.round(w));
      renderH = Math.max(2, Math.round(h));
      applyLayout();
    },

    getRenderSize() {
      return { w: renderW, h: renderH };
    },

    refit() {
      applyLayout();
    },

    /** Live (non-deterministic) preview render. */
    render(project) {
      return loadDoc(buildDoc(project, false), false);
    },

    /** Build a deterministic document and wait for the harness. */
    loadDeterministic(project) {
      return loadDoc(buildDoc(project, true), true);
    },

    win() {
      return iframe ? iframe.contentWindow : null;
    },
    doc() {
      try {
        return iframe.contentDocument || iframe.contentWindow.document;
      } catch (e) {
        return null;
      }
    },

    /**
     * Serialise the current preview document into a self-contained HTML
     * string for the native SVG <foreignObject> snapshot used by DOM capture.
     *
     * SVG foreignObject cannot reference external stylesheets, so we INLINE
     * the computed style of every element. We also clone any <canvas> as an
     * <img> of its current pixels, so 2D/WebGL canvases appear in DOM mode too.
     */
    serializeBody() {
      const d = this.doc();
      if (!d || !d.body) return "";

      const clone = d.body.cloneNode(true);

      // Copy computed styles onto the clones so they render without the
      // original stylesheet. We walk source and clone trees in lockstep.
      const srcNodes = [d.body].concat(Array.prototype.slice.call(d.body.querySelectorAll("*")));
      const dstNodes = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll("*")));
      const win = this.win();

      for (let i = 0; i < srcNodes.length; i++) {
        const src = srcNodes[i];
        const dst = dstNodes[i];
        if (!dst || dst.nodeType !== 1) continue;

        // Replace <canvas> with a snapshot <img>.
        if (src.tagName === "CANVAS") {
          try {
            const img = d.createElement("img");
            img.src = src.toDataURL("image/png");
            img.width = src.clientWidth || src.width;
            img.height = src.clientHeight || src.height;
            if (dst.parentNode) dst.parentNode.replaceChild(img, dst);
          } catch (e) { /* tainted canvas: leave as-is */ }
          continue;
        }

        try {
          const cs = win.getComputedStyle(src);
          let css = "";
          for (let j = 0; j < cs.length; j++) {
            const prop = cs[j];
            css += prop + ":" + cs.getPropertyValue(prop) + ";";
          }
          dst.setAttribute("style", css);
        } catch (e) { /* ignore */ }
      }

      // Remove scripts from the snapshot (no need, and they shouldn't run).
      clone.querySelectorAll("script").forEach((s) => s.remove());

      const bg = (function () {
        try { return win.getComputedStyle(d.body).backgroundColor || "#fff"; }
        catch (e) { return "#fff"; }
      })();

      return (
        '<div style="width:100%;height:100%;background:' + bg + ';">' +
        clone.innerHTML +
        "</div>"
      );
    },

    /** Find a full-bleed <canvas> in the preview (for direct canvas capture). */
    findCanvas() {
      const d = this.doc();
      if (!d) return null;
      const canvases = d.querySelectorAll("canvas");
      if (!canvases.length) return null;
      // Prefer the largest canvas.
      let best = canvases[0];
      let bestArea = 0;
      canvases.forEach((c) => {
        const area = (c.width || 0) * (c.height || 0);
        if (area > bestArea) {
          bestArea = area;
          best = c;
        }
      });
      return best;
    },

    buildDoc, // exported for the recorder
  };

  window.Preview = Preview;
})();
