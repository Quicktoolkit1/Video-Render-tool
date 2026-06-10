/* =======================================================================
 * preview.js — Builds the preview <iframe> document and manages sizing.
 *
 * HIGH QUALITY: the iframe renders at the *full* export resolution
 * (e.g. 1920x1080). The visible preview is just a CSS-scaled view, so
 * `innerWidth/innerHeight` inside the user's code equal the real export
 * size and every captured frame is at native resolution.
 *
 * The preview always runs LIVE (real time). The recorder captures it as it
 * plays — this is the most reliable approach and never hangs.
 *
 * Exposes a global `Preview` object.
 * ===================================================================== */
(function () {
  "use strict";

  let iframe, frameEl, stageEl, dimReadout;
  let renderW = 1920;
  let renderH = 1080;

  function buildDoc(project) {
    const head =
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      "<style>html,body{margin:0;padding:0;width:100%;height:100%;}\n" +
      (project.css || "") +
      "</style></head><body>";

    // body HTML (may include CDN <script> tags) then the user's JS.
    // CDN <script src> tags run in document order, so libraries referenced
    // in the HTML are ready before the user JS block executes.
    const body =
      (project.html || "") +
      '<script>\ntry{\n' +
      (project.js || "") +
      "\n}catch(e){console.error(e);document.title='ERROR: '+e.message;}\n<\/script>";

    return head + body + "</body></html>";
  }

  function applyLayout() {
    if (!iframe) return;
    iframe.style.width = renderW + "px";
    iframe.style.height = renderH + "px";

    const stageRect = stageEl.getBoundingClientRect();
    const padding = 36;
    const availW = Math.max(80, stageRect.width - padding);
    const availH = Math.max(80, stageRect.height - padding);
    const scale = Math.min(availW / renderW, availH / renderH, 1);

    frameEl.style.width = Math.round(renderW * scale) + "px";
    frameEl.style.height = Math.round(renderH * scale) + "px";

    iframe.style.transformOrigin = "top left";
    iframe.style.transform = "scale(" + scale + ")";

    if (dimReadout) {
      dimReadout.textContent =
        renderW + " × " + renderH + "  (" + Math.round(scale * 100) + "% view)";
    }
  }

  function loadDoc(srcdoc) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve(iframe.contentWindow);
      };
      iframe.onload = () => setTimeout(done, 30);
      // Fallback in case onload doesn't fire for some reason.
      setTimeout(done, 1500);
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

    /** Live preview render. */
    render(project) {
      return loadDoc(buildDoc(project));
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
     * Wait until the scene is ready to capture.
     * - If a canvas is expected, wait until one exists AND has been drawn to.
     * - Otherwise, wait until the body has any visible content.
     * Resolves (does not reject) once ready or after a short internal cap.
     */
    waitUntilReady(wantCanvas) {
      return new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
          const d = this.doc();
          if (d) {
            if (wantCanvas) {
              const c = this.findCanvas();
              if (c && (c.width > 1 && c.height > 1)) return resolve(true);
            } else {
              if (d.body && (d.body.children.length > 0 || (d.body.textContent || "").trim())) {
                return resolve(true);
              }
            }
          }
          if (Date.now() - started > 4000) return resolve(false);
          setTimeout(tick, 60);
        };
        tick();
      });
    },

    /**
     * Serialise the current preview document into a self-contained XHTML
     * string for the native SVG <foreignObject> snapshot used by DOM capture.
     * Computed styles are inlined (foreignObject can't use external CSS), and
     * any <canvas> is replaced by an <img> of its current pixels.
     */
    serializeBody() {
      const d = this.doc();
      if (!d || !d.body) return "";
      const win = this.win();

      const clone = d.body.cloneNode(true);

      const srcNodes = [d.body].concat(Array.prototype.slice.call(d.body.querySelectorAll("*")));
      const dstNodes = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll("*")));

      for (let i = 0; i < srcNodes.length; i++) {
        const src = srcNodes[i];
        const dst = dstNodes[i];
        if (!dst || dst.nodeType !== 1) continue;

        if (src.tagName === "CANVAS") {
          try {
            const img = d.createElement("img");
            img.setAttribute("src", src.toDataURL("image/png"));
            img.setAttribute("width", src.clientWidth || src.width);
            img.setAttribute("height", src.clientHeight || src.height);
            if (dst.parentNode) dst.parentNode.replaceChild(img, dst);
          } catch (e) { /* tainted canvas */ }
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

      Array.prototype.slice.call(clone.querySelectorAll("script")).forEach((s) => s.remove());

      let bg = "#ffffff";
      try { bg = win.getComputedStyle(d.body).backgroundColor || "#ffffff"; } catch (e) {}

      // Wrap in an XHTML-namespaced div so it renders inside <foreignObject>.
      return (
        '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + renderW +
        "px;height:" + renderH + "px;background:" + bg + ';overflow:hidden;">' +
        clone.innerHTML +
        "</div>"
      );
    },

    /** Find the largest <canvas> in the preview (for direct canvas capture). */
    findCanvas() {
      const d = this.doc();
      if (!d) return null;
      const canvases = d.querySelectorAll("canvas");
      if (!canvases.length) return null;
      let best = canvases[0];
      let bestArea = 0;
      canvases.forEach((c) => {
        const area = (c.width || 0) * (c.height || 0);
        if (area > bestArea) { bestArea = area; best = c; }
      });
      return best;
    },

    buildDoc,
  };

  window.Preview = Preview;
})();
