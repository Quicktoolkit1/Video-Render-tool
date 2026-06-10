/* =======================================================================
 * recorder.js — The rendering / encoding engine (robust, mobile-safe).
 *
 * GOAL: Run preview -> Export must ALWAYS finish with a video or a clear
 * error. It must NEVER hang at 0%.
 *
 * Two encoders, chosen automatically:
 *   1. WebCodecs + mp4-muxer  -> true high-quality MP4 (desktop Chrome/Edge).
 *   2. MediaRecorder          -> real-time capture (works great on mobile;
 *                                produces MP4 where supported, else WebM).
 *
 * KEY ROBUSTNESS: every browser call that *could* stall (especially
 * VideoEncoder.isConfigSupported / configure / flush on mobile) is wrapped
 * in a timeout. If the WebCodecs path stalls or errors for ANY reason, we
 * fall back to MediaRecorder. MediaRecorder for a <canvas> uses the canvas's
 * own captureStream so frames flow automatically — the most reliable path.
 *
 * Exposes a global `Recorder` object.
 * ===================================================================== */
(function () {
  "use strict";

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function nextFrame() { return new Promise((r) => requestAnimationFrame(() => r())); }

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
  function hasMediaRecorder() { return typeof window.MediaRecorder === "function"; }

  function detectCapabilities() {
    if (hasWebCodecs()) {
      return { mode: "webcodecs", label: "MP4 · WebCodecs (high quality)", good: true, mp4: true };
    }
    if (hasMediaRecorder()) {
      const mp4 = MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("video/mp4");
      return {
        mode: "mediarecorder",
        label: mp4 ? "MP4 · MediaRecorder" : "WebM · MediaRecorder",
        good: false,
        mp4: !!mp4,
      };
    }
    return { mode: "none", label: "No video encoder available", good: false, mp4: false };
  }

  // Guarded codec probe. isConfigSupported can hang on some mobile builds,
  // so each probe is time-limited; total probing is also capped.
  async function pickAvcCodec(width, height, bitrate, fps) {
    const candidates = [
      "avc1.640034", "avc1.640033", "avc1.640032",
      "avc1.64002A", "avc1.640028", "avc1.640020",
      "avc1.4D4028", "avc1.42E01F", "avc1.42E01E",
    ];
    for (const codec of candidates) {
      try {
        const res = await withTimeout(
          VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps }),
          2500,
          "Codec probe"
        );
        if (res && res.supported) return codec;
      } catch (e) { /* try next */ }
    }
    return null;
  }

  function waitQueue(encoder, max, capMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (encoder.encodeQueueSize <= max) return resolve();
        if (Date.now() - start > capMs) return reject(new Error("Encoder queue stalled"));
        setTimeout(check, 6);
      };
      check();
    });
  }

  /* ------------------------------ painters -------------------------- */
  function canvasPainter(getCanvas, octx, width, height) {
    return async function paint() {
      const src = getCanvas();
      octx.fillStyle = "#000";
      octx.fillRect(0, 0, width, height);
      if (!src) return;
      try { octx.drawImage(src, 0, 0, width, height); }
      catch (e) { throw new Error("Could not read the <canvas> (cross-origin image taint)."); }
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
          8000, "DOM snapshot"
        );
        octx.fillStyle = "#fff";
        octx.fillRect(0, 0, width, height);
        octx.drawImage(img, 0, 0, width, height);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
  }

  /* --------------------- WebCodecs encode (real-time paced) --------- */
  async function encodeWebCodecs(ctx) {
    const { width, height, fps, frames, bitrate, out, paint, onProgress, isCancelled } = ctx;

    const codec = await pickAvcCodec(width, height, bitrate, fps);
    if (!codec) throw new Error("No supported H.264 config (probe failed/timed out).");

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
    // Let configure settle; if the encoder is going to fault, surface it.
    await sleep(60);
    if (encError) throw encError;

    const frameDurUs = 1e6 / fps;
    const gop = Math.max(1, Math.round(fps * 2));
    const frameInterval = 1000 / fps;
    const startWall = performance.now();

    for (let i = 0; i < frames; i++) {
      if (isCancelled()) break;
      if (encError) throw encError;

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

      if (encoder.encodeQueueSize > 6) await waitQueue(encoder, 4, 15000);
      onProgress((i + 1) / frames, "Encoding frames", i + 1 + " / " + frames);
    }

    onProgress(1, "Finalising MP4", "");
    await withTimeout(encoder.flush(), 15000, "Finalising");
    if (encError) throw encError;
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), ext: "mp4", mime: "video/mp4" };
  }

  /* --------------------- MediaRecorder fallback --------------------- */
  function pickRecorderMime() {
    const list = [
      "video/mp4;codecs=avc1.640028",
      "video/mp4",
      "video/webm;codecs=h264",
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
    const { fps, duration, bitrate, out, paint, useDom, getSrcCanvas, onProgress, isCancelled } = ctx;

    const mime = pickRecorderMime();
    const ext = mime.indexOf("mp4") !== -1 ? "mp4" : "webm";

    let stream;
    let manualDraw;
    const srcCanvas = useDom ? null : getSrcCanvas();

    if (!useDom && srcCanvas && typeof srcCanvas.captureStream === "function") {
      // BEST mobile path: capture the live canvas directly. Frames flow as
      // the animation runs — no manual pushing, nothing to stall.
      stream = srcCanvas.captureStream(fps);
      manualDraw = false;
    } else {
      // DOM (or no captureStream): paint into our canvas and push frames.
      stream = out.captureStream(0);
      manualDraw = true;
    }

    const track = stream.getVideoTracks()[0];
    const chunks = [];
    let opts = {};
    try { opts = { mimeType: mime, videoBitsPerSecond: bitrate }; } catch (e) {}
    let rec;
    try { rec = new MediaRecorder(stream, opts); }
    catch (e) { rec = new MediaRecorder(stream); } // last-resort defaults

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
          if (manualDraw) {
            await withTimeout(paint(), 12000, "Rendering frame");
            if (track && track.requestFrame) track.requestFrame();
            else if (stream.requestFrame) stream.requestFrame();
          }
          onProgress(Math.min(0.99, elapsed / totalMs), "Recording (real-time)", (Math.round(elapsed / 100) / 10) + "s");
          requestAnimationFrame(tick);
        } catch (err) { reject(err); }
      };
      requestAnimationFrame(tick);
    });

    onProgress(1, "Finalising", "");
    rec.stop();
    await withTimeout(stopped, 10000, "Recorder finalise");
    stream.getTracks().forEach((t) => t.stop());
    if (!chunks.length) throw new Error("Recorder produced no data. Try a different capture mode.");
    return { blob: new Blob(chunks, { type: mime }), ext, mime };
  }

  /* ------------------------------ public ---------------------------- */
  const Recorder = {
    detectCapabilities,

    // Preferred mode can be downgraded by a preflight self-test.
    _forcedMode: null,

    /**
     * One-time self-test: actually try to configure + encode ONE tiny frame
     * with WebCodecs, all under tight timeouts. If anything stalls or throws
     * (common on some mobile browsers that *advertise* WebCodecs but can't
     * really use it), we permanently prefer MediaRecorder. This is what
     * prevents the dreaded "stuck at 0%".
     */
    async preflight() {
      if (!hasWebCodecs()) {
        this._forcedMode = hasMediaRecorder() ? "mediarecorder" : "none";
        return this.activeCapabilities();
      }
      try {
        await withTimeout(this._probeEncode(), 4000, "WebCodecs self-test");
        this._forcedMode = "webcodecs";
      } catch (e) {
        console.warn("WebCodecs self-test failed; using MediaRecorder.", e);
        this._forcedMode = hasMediaRecorder() ? "mediarecorder" : "none";
      }
      return this.activeCapabilities();
    },

    _probeEncode() {
      return new Promise((resolve, reject) => {
        try {
          const cv = document.createElement("canvas");
          cv.width = 64; cv.height = 64;
          const c = cv.getContext("2d");
          c.fillStyle = "#123"; c.fillRect(0, 0, 64, 64);

          let got = false;
          const enc = new VideoEncoder({
            output: () => { if (!got) { got = true; try { enc.close(); } catch (e) {} resolve(true); } },
            error: (e) => reject(e),
          });
          // Probe a widely-supported config.
          VideoEncoder.isConfigSupported({ codec: "avc1.42E01E", width: 64, height: 64, bitrate: 1e6, framerate: 30 })
            .then((res) => {
              const codec = res && res.supported ? "avc1.42E01E" : "avc1.640028";
              enc.configure({ codec, width: 64, height: 64, bitrate: 1e6, framerate: 30 });
              const frame = new VideoFrame(cv, { timestamp: 0, duration: 33333 });
              enc.encode(frame, { keyFrame: true });
              frame.close();
              enc.flush().catch(reject);
            })
            .catch(reject);
        } catch (e) { reject(e); }
      });
    },

    /** Capabilities after preflight (honours the forced mode). */
    activeCapabilities() {
      const base = detectCapabilities();
      if (this._forcedMode === "mediarecorder" && hasMediaRecorder()) {
        const mp4 = MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("video/mp4");
        return { mode: "mediarecorder", label: mp4 ? "MP4 · MediaRecorder" : "WebM · MediaRecorder", good: false, mp4: !!mp4 };
      }
      if (this._forcedMode === "none") return { mode: "none", label: "No video encoder available", good: false, mp4: false };
      return base;
    },

    async export (opts) {
      const { project, settings, onProgress, isCancelled } = opts;
      const caps = this.activeCapabilities();
      if (caps.mode === "none") throw new Error("This browser has no video encoder. Please use Chrome or Edge.");

      const { width, height, fps, frames, duration, bitrate, captureMode } = settings;

      onProgress(0, "Preparing scene", "");
      await withTimeout(window.Preview.render(project), 8000, "Loading preview");
      const doc = window.Preview.doc();
      if (!doc) throw new Error("Could not access the preview document.");

      onProgress(0.01, "Waiting for content", "");
      const wantCanvas = captureMode === "canvas" || captureMode === "auto";
      await withTimeout(window.Preview.waitUntilReady(wantCanvas), 6000, "Waiting for content").catch(() => {});

      await sleep(120);
      await nextFrame();

      let useDom;
      if (captureMode === "dom") useDom = true;
      else if (captureMode === "canvas") {
        if (!window.Preview.findCanvas()) throw new Error("Canvas mode selected, but no <canvas> was found.");
        useDom = false;
      } else {
        useDom = !window.Preview.findCanvas();
      }

      const out = document.createElement("canvas");
      out.width = width;
      out.height = height;
      const octx = out.getContext("2d", { alpha: false });

      const paint = useDom
        ? makeDomPainter(() => window.Preview.serializeBody(), octx, width, height)
        : canvasPainter(() => window.Preview.findCanvas(), octx, width, height);

      onProgress(0.02, "Rendering first frame", "");
      await withTimeout(paint(), 12000, "First frame");

      const ctx = {
        width, height, fps, frames, duration, bitrate,
        out, octx, paint, useDom,
        getSrcCanvas: () => window.Preview.findCanvas(),
        onProgress, isCancelled,
      };

      if (caps.mode === "webcodecs") {
        try {
          return await encodeWebCodecs(ctx);
        } catch (err) {
          if (isCancelled()) throw err;
          console.warn("WebCodecs failed; falling back to MediaRecorder:", err);
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
