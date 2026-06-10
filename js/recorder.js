/* =======================================================================
 * recorder.js — The rendering / encoding engine.
 *
 * Encoders:
 *   1. WebCodecs VideoEncoder + mp4-muxer  -> true high-quality H.264 MP4,
 *      frame-accurate and deterministic. (Chrome / Edge, modern browsers.)
 *   2. MediaRecorder fallback               -> real-time capture, webm/mp4.
 *
 * Frame sources:
 *   - Canvas: copy the preview's <canvas> each frame (p5 / three / 2d).
 *   - DOM:    NATIVE snapshot via SVG <foreignObject> (no external libs).
 *             This is reliable inside an iframe and never hangs, unlike
 *             html2canvas which we deliberately removed.
 *
 * Robustness:
 *   - Every async step is guarded by a timeout so the UI can NEVER get
 *     stuck silently at 0%. Failures surface as clear, readable errors.
 *
 * Exposes a global `Recorder` object.
 * ===================================================================== */
(function () {
  "use strict";

  /* ----------------------------- utils ----------------------------- */
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Reject if a promise does not settle within `ms`.
  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error((label || "Step") + " timed out after " + ms + "ms"));
      }, ms);
      Promise.resolve(promise).then(
        (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } }
      );
    });
  }

  function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }

  /* ------------------------- capabilities --------------------------- */
  const hasWebCodecs =
    typeof window.VideoEncoder === "function" &&
    typeof window.VideoFrame === "function" &&
    typeof window.Mp4Muxer !== "undefined";

  const hasMediaRecorder = typeof window.MediaRecorder === "function";

  function detectCapabilities() {
    if (hasWebCodecs) {
      return { mode: "webcodecs", label: "MP4 · WebCodecs (high quality)", good: true, mp4: true };
    }
    if (hasMediaRecorder) {
      const mp4 = MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("video/mp4");
      return {
        mode: "mediarecorder",
        label: mp4 ? "MP4 · MediaRecorder" : "WebM · MediaRecorder (fallback)",
        good: false,
        mp4: !!mp4,
      };
    }
    return { mode: "none", label: "No video encoder available", good: false, mp4: false };
  }

  async function pickAvcCodec(width, height, bitrate, fps) {
    const candidates = [
      "avc1.640034", "avc1.640033", "avc1.640032",
      "avc1.64002A", "avc1.640028", "avc1.640020",
      "avc1.4D4028", "avc1.42E01F", "avc1.42E01E",
    ];
    for (const codec of candidates) {
      try {
        const res = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps });
        if (res && res.supported) return codec;
      } catch (e) { /* try next */ }
    }
    return null;
  }

  function waitQueue(encoder, max) {
    return new Promise((resolve) => {
      const check = () => {
        if (encoder.encodeQueueSize <= max) resolve();
        else setTimeout(check, 4);
      };
      check();
    });
  }

  /* --------------------------------------------------------------- *
   * Frame stepping: advance JS animations (virtual clock) AND scrub
   * CSS animations / transitions via the Web Animations API.
   * --------------------------------------------------------------- */
  function makeStepper(win, doc, deterministic) {
    return function step(tMs) {
      if (!deterministic) return;
      try { if (win && typeof win.__vStep === "function") win.__vStep(tMs); } catch (e) {}
      try {
        if (doc && doc.getAnimations) {
          doc.getAnimations().forEach((a) => {
            try { a.pause(); a.currentTime = tMs; } catch (e) {}
          });
        }
      } catch (e) {}
    };
  }

  /* --------------------------------------------------------------- *
   * Frame painters
   * --------------------------------------------------------------- */
  function canvasPainter(srcCanvas, octx, width, height) {
    return async function paint() {
      octx.fillStyle = "#000";
      octx.fillRect(0, 0, width, height);
      try {
        octx.drawImage(srcCanvas, 0, 0, width, height);
      } catch (e) {
        throw new Error("Could not read the <canvas> (it may be tainted by a cross-origin image).");
      }
    };
  }

  /**
   * Native DOM painter: serialise the iframe document into an SVG
   * <foreignObject> and draw it onto an Image. No external library.
   * This avoids the html2canvas iframe-hang problem entirely.
   */
  function makeDomPainter(getDocHtml, octx, width, height) {
    return async function paint() {
      const html = getDocHtml();
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">' +
        '<foreignObject width="100%" height="100%">' +
        '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + width + 'px;height:' + height + 'px;">' +
        html +
        "</div></foreignObject></svg>";

      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      try {
        const img = await withTimeout(
          new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error("DOM snapshot failed. Some external images/fonts can't be inlined; try Canvas mode."));
            im.src = url;
          }),
          8000,
          "DOM snapshot"
        );
        octx.fillStyle = "#fff";
        octx.fillRect(0, 0, width, height);
        octx.drawImage(img, 0, 0, width, height);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
  }

  /* --------------------------------------------------------------- *
   * WebCodecs encode (deterministic, frame-by-frame)
   * --------------------------------------------------------------- */
  async function encodeWebCodecs(ctx) {
    const { width, height, fps, frames, bitrate, out, step, paint, deterministic, onProgress, isCancelled } = ctx;

    const codec = await pickAvcCodec(width, height, bitrate, fps);
    if (!codec) {
      throw new Error("This browser's H.264 encoder does not support " + width + "×" + height + ". Try a lower resolution.");
    }

    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: "avc", width, height },
      fastStart: "in-memory",
    });

    let encError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encError = e; },
    });
    encoder.configure({ codec, width, height, bitrate, framerate: fps, latencyMode: "quality" });

    const frameDurUs = 1e6 / fps;
    const gop = Math.max(1, Math.round(fps * 2));

    for (let i = 0; i < frames; i++) {
      if (isCancelled()) break;
      if (encError) throw encError;

      if (!deterministic && i > 0) await sleep(1000 / fps);

      const tMs = (i * 1000) / fps;
      step(tMs);
      await withTimeout(paint(), 12000, "Rendering frame " + (i + 1));

      const frame = new VideoFrame(out, {
        timestamp: Math.round(i * frameDurUs),
        duration: Math.round(frameDurUs),
      });
      encoder.encode(frame, { keyFrame: i % gop === 0 });
      frame.close();

      if (encoder.encodeQueueSize > 6) await waitQueue(encoder, 4);
      onProgress((i + 1) / frames, "Encoding frames", i + 1 + " / " + frames);
    }

    onProgress(1, "Finalising MP4", "");
    await encoder.flush();
    if (encError) throw encError;
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), ext: "mp4", mime: "video/mp4" };
  }

  /* --------------------------------------------------------------- *
   * MediaRecorder fallback (real-time)
   * --------------------------------------------------------------- */
  function pickRecorderMime() {
    const list = [
      "video/mp4;codecs=avc1.640028",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    for (const m of list) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
    }
    return "video/webm";
  }

  async function encodeMediaRecorder(ctx) {
    const { width, height, fps, duration, bitrate, out, paint, useDom, srcCanvas, onProgress, isCancelled } = ctx;

    const mime = pickRecorderMime();
    const ext = mime.indexOf("mp4") !== -1 ? "mp4" : "webm";

    let stream, manualDraw = false, track = null;
    if (!useDom && srcCanvas && srcCanvas.captureStream) {
      // Mirror the live canvas into our output canvas in real time, capture that.
      stream = out.captureStream(fps);
      manualDraw = true;
      track = stream.getVideoTracks()[0];
    } else {
      stream = out.captureStream(0);
      track = stream.getVideoTracks()[0];
      manualDraw = true;
    }

    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((resolve) => (rec.onstop = resolve));
    rec.start(100);

    const totalMs = duration * 1000;
    const t0 = performance.now();

    await new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          const elapsed = performance.now() - t0;
          if (isCancelled() || elapsed >= totalMs) return resolve();
          if (manualDraw) {
            await withTimeout(paint(), 12000, "Rendering frame");
            if (track && track.requestFrame) track.requestFrame();
          }
          onProgress(Math.min(1, elapsed / totalMs), "Recording (real-time)", (Math.round(elapsed / 100) / 10) + "s");
          requestAnimationFrame(tick);
        } catch (err) {
          reject(err);
        }
      };
      requestAnimationFrame(tick);
    });

    rec.stop();
    await done;
    stream.getTracks().forEach((t) => t.stop());
    return { blob: new Blob(chunks, { type: mime }), ext, mime };
  }

  /* --------------------------------------------------------------- *
   * Public API
   * --------------------------------------------------------------- */
  const Recorder = {
    detectCapabilities,

    async export (opts) {
      const { project, settings, onProgress, isCancelled } = opts;
      const caps = detectCapabilities();
      if (caps.mode === "none") throw new Error("No supported video encoder in this browser. Try Chrome or Edge.");

      const { width, height, fps, frames, duration, bitrate, captureMode, deterministic } = settings;
      const useDeterministic = deterministic && caps.mode === "webcodecs";

      onProgress(0, "Preparing scene", "");

      // Load the preview document, guarded by a timeout so we never hang here.
      const win = await withTimeout(
        useDeterministic
          ? window.Preview.loadDeterministic(project)
          : window.Preview.render(project),
        8000,
        "Loading preview"
      );
      const doc = window.Preview.doc();
      if (!doc) throw new Error("Could not access the preview document.");

      const step = makeStepper(win, doc, useDeterministic);

      // Let libraries (p5/three) create their canvas, then settle on frame 0.
      step(0);
      await sleep(150);
      await nextFrame();

      // Decide frame source.
      let srcCanvas = null;
      if (captureMode === "canvas" || captureMode === "auto") {
        srcCanvas = window.Preview.findCanvas();
      }
      const useDom = captureMode === "dom" || (captureMode === "auto" && !srcCanvas);
      if (captureMode === "canvas" && !srcCanvas) {
        throw new Error("Canvas mode selected, but no <canvas> was found in the preview.");
      }

      // Output canvas at the true export resolution.
      const out = document.createElement("canvas");
      out.width = width;
      out.height = height;
      const octx = out.getContext("2d", { alpha: false, willReadFrequently: false });

      const paint = useDom
        ? makeDomPainter(() => window.Preview.serializeBody(), octx, width, height)
        : canvasPainter(srcCanvas, octx, width, height);

      // Do ONE test paint up front so problems surface immediately (not at 0%).
      onProgress(0.01, "Rendering first frame", "");
      await withTimeout(paint(), 12000, "First frame");

      const ctx = {
        width, height, fps, frames, duration, bitrate,
        out, octx, step, paint, useDom, srcCanvas,
        deterministic: useDeterministic, onProgress, isCancelled,
      };

      if (caps.mode === "webcodecs") return await encodeWebCodecs(ctx);
      return await encodeMediaRecorder(ctx);
    },
  };

  window.Recorder = Recorder;
})();
