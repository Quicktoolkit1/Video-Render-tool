/* =======================================================================
 * recorder.js — The rendering / encoding engine.
 *
 * Two encoders:
 *   1. WebCodecs VideoEncoder + mp4-muxer  -> true high-quality H.264 MP4,
 *      frame-accurate and deterministic. (Chrome / Edge, modern browsers.)
 *   2. MediaRecorder fallback               -> real-time capture, webm/mp4.
 *
 * Two frame sources:
 *   - Canvas: copy the preview's <canvas> each frame (great for p5/three/2d).
 *   - DOM:    html2canvas snapshot each frame (general HTML/CSS).
 *
 * Deterministic timing combines:
 *   - the virtual clock harness (win.__vStep)  -> JS / rAF animations
 *   - the Web Animations API (currentTime)     -> CSS animations & transitions
 *
 * Exposes a global `Recorder` object.
 * ===================================================================== */
(function () {
  "use strict";

  const hasWebCodecs =
    typeof window.VideoEncoder === "function" &&
    typeof window.VideoFrame === "function" &&
    typeof window.Mp4Muxer !== "undefined";

  const hasMediaRecorder = typeof window.MediaRecorder === "function";

  function detectCapabilities() {
    if (hasWebCodecs) {
      return {
        mode: "webcodecs",
        label: "MP4 · WebCodecs (high quality)",
        good: true,
        mp4: true,
      };
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
        const res = await VideoEncoder.isConfigSupported({
          codec, width, height, bitrate, framerate: fps,
        });
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

  /* ----------------------------------------------------------------- *
   * Frame stepping: advance JS animations (virtual clock) AND scrub
   * CSS animations / transitions via the Web Animations API.
   * ----------------------------------------------------------------- */
  function makeStepper(win, doc, deterministic) {
    return function step(tMs) {
      if (!deterministic) return;
      try {
        if (win && typeof win.__vStep === "function") win.__vStep(tMs);
      } catch (e) { /* ignore user errors */ }
      try {
        if (doc && doc.getAnimations) {
          doc.getAnimations().forEach((a) => {
            try {
              a.pause();
              a.currentTime = tMs;
            } catch (e) { /* some animations are not seekable */ }
          });
        }
      } catch (e) { /* ignore */ }
    };
  }

  /* ----------------------------------------------------------------- *
   * Frame painters
   * ----------------------------------------------------------------- */
  function canvasPainter(srcCanvas, octx, width, height) {
    return async function paint() {
      octx.clearRect(0, 0, width, height);
      try {
        octx.drawImage(srcCanvas, 0, 0, width, height);
      } catch (e) { /* drawImage can throw if tainted; ignore */ }
    };
  }

  function domPainter(doc, octx, width, height) {
    const root = doc.documentElement || doc.body;
    return async function paint() {
      const snap = await window.html2canvas(root, {
        backgroundColor: "#ffffff",
        width,
        height,
        windowWidth: width,
        windowHeight: height,
        scale: 1,
        useCORS: true,
        logging: false,
      });
      octx.clearRect(0, 0, width, height);
      octx.drawImage(snap, 0, 0, width, height);
    };
  }

  /* ----------------------------------------------------------------- *
   * WebCodecs encode (deterministic, frame-by-frame)
   * ----------------------------------------------------------------- */
  async function encodeWebCodecs(ctx) {
    const { width, height, fps, frames, bitrate, out, octx, step, paint, onProgress, isCancelled } = ctx;

    const codec = await pickAvcCodec(width, height, bitrate, fps);
    if (!codec) throw new Error("This browser's H.264 encoder does not support " + width + "×" + height + ". Try a lower resolution.");

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
    encoder.configure({
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      latencyMode: "quality",
    });

    const frameDurUs = 1e6 / fps;
    const gop = Math.max(1, Math.round(fps * 2)); // keyframe every ~2s

    for (let i = 0; i < frames; i++) {
      if (isCancelled()) break;
      if (encError) throw encError;

      const tMs = (i * 1000) / fps;
      step(tMs);
      await paint();

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
    const buffer = muxer.target.buffer;
    return { blob: new Blob([buffer], { type: "video/mp4" }), ext: "mp4", mime: "video/mp4" };
  }

  /* ----------------------------------------------------------------- *
   * MediaRecorder fallback (real-time)
   * ----------------------------------------------------------------- */
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
    const { width, height, fps, duration, bitrate, out, octx, paint, useDom, srcCanvas, onProgress, isCancelled } = ctx;

    const mime = pickRecorderMime();
    const ext = mime.indexOf("mp4") !== -1 ? "mp4" : "webm";

    // Choose the stream source.
    let stream, manualDraw = false, track = null;
    if (!useDom && srcCanvas && srcCanvas.captureStream) {
      stream = srcCanvas.captureStream(fps); // native canvas frames, best quality
    } else {
      stream = out.captureStream(0); // we push frames manually
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

    // Real-time render loop.
    await new Promise((resolve) => {
      const tick = async () => {
        const elapsed = performance.now() - t0;
        if (isCancelled() || elapsed >= totalMs) return resolve();
        if (manualDraw) {
          await paint();
          if (track && track.requestFrame) track.requestFrame();
        }
        onProgress(Math.min(1, elapsed / totalMs), "Recording (real-time)", Math.round(elapsed / 100) / 10 + "s");
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    rec.stop();
    await done;
    stream.getTracks().forEach((t) => t.stop());
    return { blob: new Blob(chunks, { type: mime }), ext, mime };
  }

  /* ----------------------------------------------------------------- *
   * Public API
   * ----------------------------------------------------------------- */
  const Recorder = {
    detectCapabilities,

    /**
     * @param {Object} opts
     *   project, settings, onProgress(fraction,label,sub), isCancelled()
     * @returns {Promise<{blob, ext, mime}>}
     */
    async export (opts) {
      const { project, settings, onProgress, isCancelled } = opts;
      const caps = detectCapabilities();
      if (caps.mode === "none") throw new Error("No supported video encoder in this browser.");

      const { width, height, fps, frames, duration, bitrate, captureMode, deterministic } = settings;

      const useDeterministic = deterministic && caps.mode === "webcodecs";

      onProgress(0, "Preparing scene", "");

      // Load the preview document (deterministic harness only when we can use it).
      const win = useDeterministic
        ? await window.Preview.loadDeterministic(project)
        : await window.Preview.render(project);
      const doc = window.Preview.doc();

      const step = makeStepper(win, doc, useDeterministic);

      // Initial step so libraries (p5/three) create their canvas, then settle.
      step(0);
      await new Promise((r) => setTimeout(r, 120));

      // Decide frame source.
      let srcCanvas = null;
      if (captureMode === "canvas" || captureMode === "auto") {
        srcCanvas = window.Preview.findCanvas();
      }
      const useDom = captureMode === "dom" || (captureMode === "auto" && !srcCanvas);
      if (captureMode === "canvas" && !srcCanvas) {
        throw new Error("Canvas mode selected but no <canvas> was found in the preview.");
      }
      if (useDom && typeof window.html2canvas !== "function") {
        throw new Error("DOM capture needs html2canvas, which failed to load (offline?).");
      }

      // Output canvas at the true export resolution.
      const out = document.createElement("canvas");
      out.width = width;
      out.height = height;
      const octx = out.getContext("2d", { alpha: false, willReadFrequently: false });

      const paint = useDom
        ? domPainter(doc, octx, width, height)
        : canvasPainter(srcCanvas, octx, width, height);

      const ctx = {
        width, height, fps, frames, duration, bitrate,
        out, octx, step, paint, useDom, srcCanvas, onProgress, isCancelled,
      };

      if (caps.mode === "webcodecs") {
        return await encodeWebCodecs(ctx);
      }
      return await encodeMediaRecorder(ctx);
    },
  };

  window.Recorder = Recorder;
})();
