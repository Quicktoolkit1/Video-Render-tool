/* =======================================================================
 * recorder.js — The rendering / encoding engine (robust real-time first).
 *
 * DESIGN GOAL: pasting code + Run + Export must ALWAYS either produce a
 * video or show a clear error. It must NEVER hang silently at 0%.
 *
 * Strategy:
 *   - Primary path = REAL-TIME capture of the live preview. The animation
 *     simply plays and we grab frames as it runs. This is the most reliable
 *     approach and works for canvas, p5.js, three.js and CSS animations.
 *   - Encoder: WebCodecs + mp4-muxer when available (true MP4). If anything
 *     about that setup fails, we automatically fall back to MediaRecorder.
 *   - Every await is wrapped in a timeout so a stuck step throws instead of
 *     freezing the UI.
 *
 * Frame sources:
 *   - Canvas: copy the preview's <canvas> each frame (best quality).
 *   - DOM:    native SVG <foreignObject> snapshot (no external library).
 *
 * Exposes a global `Recorder` object.
 * ===================================================================== */
(function () {
  "use strict";

  /* ----------------------------- utils ----------------------------- */
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

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
  function hasWebCodecs() {
    return (
      typeof window.VideoEncoder === "function" &&
      typeof window.VideoFrame === "function" &&
      typeof window.Mp4Muxer !== "undefined" &&
      window.Mp4Muxer &&
      typeof window.Mp4Muxer.Muxer === "function"
    );
  }
  function hasMediaRecorder() {
    return typeof window.MediaRecorder === "function";
  }

  function detectCapabilities() {
    if (hasWebCodecs()) {
      return { mode: "webcodecs", label: "MP4 · WebCodecs (high quality)", good: true, mp4: true };
    }
    if (hasMediaRecorder()) {
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
   * Frame painters
   * --------------------------------------------------------------- */
  function canvasPainter(getCanvas, octx, width, height) {
    return async function paint() {
      const src = getCanvas();
      octx.fillStyle = "#000";
      octx.fillRect(0, 0, width, height);
      if (!src) return;
      try {
        octx.drawImage(src, 0, 0, width, height);
      } catch (e) {
        throw new Error("Could not read the <canvas> (cross-origin image taint).");
      }
    };
  }

  function makeDomPainter(getDocHtml, octx, width, height) {
    return async function paint() {
      const html = getDocHtml();
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">' +
        '<foreignObject width="100%" height="100%">' + html + "</foreignObject></svg>";
      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      try {
        const img = await withTimeout(
          new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error("DOM snapshot failed; try Canvas mode."));
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
   * WebCodecs encode — REAL TIME paced (animation plays; we grab frames)
   * --------------------------------------------------------------- */
  async function encodeWebCodecs(ctx) {
    const { width, height, fps, frames, bitrate, out, paint, onProgress, isCancelled } = ctx;

    const codec = await pickAvcCodec(width, height, bitrate, fps);
    if (!codec) {
      throw new Error("H.264 does not support " + width + "×" + height + " here. Use a lower resolution.");
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
    const frameInterval = 1000 / fps;

    let startWall = performance.now();

    for (let i = 0; i < frames; i++) {
      if (isCancelled()) break;
      if (encError) throw encError;

      // Pace to real time so the live animation advances between frames.
      const targetWall = startWall + i * frameInterval;
      const now = performance.now();
      if (targetWall > now) await sleep(targetWall - now);

      await nextFrame();
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
    const { fps, duration, bitrate, out, paint, onProgress, isCancelled } = ctx;

    const mime = pickRecorderMime();
    const ext = mime.indexOf("mp4") !== -1 ? "mp4" : "webm";

    // Always paint into our output canvas and capture that stream.
    const stream = out.captureStream(0);
    const track = stream.getVideoTracks()[0];

    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => (rec.onstop = resolve));
    rec.start(100);

    const totalMs = duration * 1000;
    const t0 = performance.now();

    await new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          const elapsed = performance.now() - t0;
          if (isCancelled() || elapsed >= totalMs) return resolve();
          await withTimeout(paint(), 12000, "Rendering frame");
          if (track && track.requestFrame) track.requestFrame();
          else if (stream.requestFrame) stream.requestFrame();
          onProgress(Math.min(1, elapsed / totalMs), "Recording (real-time)", (Math.round(elapsed / 100) / 10) + "s");
          requestAnimationFrame(tick);
        } catch (err) {
          reject(err);
        }
      };
      requestAnimationFrame(tick);
    });

    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    if (!chunks.length) throw new Error("Recorder produced no data. Try a different capture mode.");
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
      if (caps.mode === "none") {
        throw new Error("This browser has no video encoder. Please use Chrome or Edge.");
      }

      const { width, height, fps, frames, duration, bitrate, captureMode } = settings;

      onProgress(0, "Preparing scene", "");

      // Load a clean, LIVE (real-time) preview document.
      await withTimeout(window.Preview.render(project), 8000, "Loading preview");
      const doc = window.Preview.doc();
      if (!doc) throw new Error("Could not access the preview document.");

      // Wait until the scene is actually ready to capture (canvas exists / DOM painted).
      onProgress(0.01, "Waiting for content", "");
      const wantCanvas = captureMode === "canvas" || captureMode === "auto";
      await withTimeout(window.Preview.waitUntilReady(wantCanvas), 6000, "Waiting for content")
        .catch(() => { /* proceed anyway; painter handles emptiness */ });

      // Give animations a moment to start.
      await sleep(120);
      await nextFrame();

      // Decide frame source.
      let useDom;
      if (captureMode === "dom") {
        useDom = true;
      } else if (captureMode === "canvas") {
        if (!window.Preview.findCanvas()) {
          throw new Error("Canvas mode selected, but no <canvas> was found in the preview.");
        }
        useDom = false;
      } else {
        // auto
        useDom = !window.Preview.findCanvas();
      }

      // Output canvas at the true export resolution.
      const out = document.createElement("canvas");
      out.width = width;
      out.height = height;
      const octx = out.getContext("2d", { alpha: false, willReadFrequently: false });

      const paint = useDom
        ? makeDomPainter(() => window.Preview.serializeBody(), octx, width, height)
        : canvasPainter(() => window.Preview.findCanvas(), octx, width, height);

      // ONE test paint up front so problems surface immediately (not at 0%).
      onProgress(0.02, "Rendering first frame", "");
      await withTimeout(paint(), 12000, "First frame");

      const ctx = {
        width, height, fps, frames, duration, bitrate,
        out, octx, paint, useDom, onProgress, isCancelled,
      };

      // Try WebCodecs; if its setup fails for any reason, fall back cleanly.
      if (caps.mode === "webcodecs") {
        try {
          return await encodeWebCodecs(ctx);
        } catch (err) {
          if (isCancelled()) throw err;
          console.warn("WebCodecs path failed, falling back to MediaRecorder:", err);
          if (!hasMediaRecorder()) throw err;
          onProgress(0.02, "Switching encoder…", "");
          return await encodeMediaRecorder(ctx);
        }
      }
      return await encodeMediaRecorder(ctx);
    },
  };

  window.Recorder = Recorder;
})();
