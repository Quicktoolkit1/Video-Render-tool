/* =======================================================================
 * settings.js — Export settings: aspect ratio, resolution, fps, duration,
 * bitrate, capture mode. Computes the real render dimensions.
 * Exposes a global `Settings` object.
 * ===================================================================== */
(function () {
  "use strict";

  const state = {
    ratioW: 16,
    ratioH: 9,
    resolution: 1080, // the SHORTER edge in pixels
    fps: 30,
    duration: 5,
    bitrateMbps: 12,
    captureMode: "auto",
    deterministic: true,
  };

  let onResizeCb = null;
  let els = {};

  function makeEven(n) {
    n = Math.round(n);
    return n % 2 === 0 ? n : n + 1;
  }

  /** Convert ratio + resolution(short edge) into even pixel dimensions. */
  function computeSize() {
    const r = state.ratioW / state.ratioH;
    let w, h;
    if (state.ratioW >= state.ratioH) {
      // landscape / square: short edge = height
      h = state.resolution;
      w = h * r;
    } else {
      // portrait: short edge = width
      w = state.resolution;
      h = w / r;
    }
    return { w: makeEven(w), h: makeEven(h) };
  }

  function fmtBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function updateSummary() {
    const { w, h } = computeSize();
    const frames = Math.round(state.fps * state.duration);
    const estBytes = (state.bitrateMbps * 1e6 * state.duration) / 8;
    els.summary.innerHTML =
      "<b>" + w + " × " + h + "</b> px · " + state.fps + " fps<br>" +
      "Duration <b>" + state.duration + "s</b> · " + frames + " frames<br>" +
      "Bitrate <b>" + state.bitrateMbps + " Mbps</b><br>" +
      "Estimated size ≈ <b>" + fmtBytes(estBytes) + "</b>";
  }

  function pushSize() {
    const { w, h } = computeSize();
    if (window.Preview) window.Preview.setRenderSize(w, h);
    updateSummary();
    if (onResizeCb) onResizeCb({ w, h });
  }

  function setRatio(w, h) {
    state.ratioW = w;
    state.ratioH = h;
    pushSize();
  }

  const Settings = {
    init(onResize) {
      onResizeCb = onResize;
      els = {
        ratioGrid: document.getElementById("ratioGrid"),
        customW: document.getElementById("customW"),
        customH: document.getElementById("customH"),
        applyCustom: document.getElementById("applyCustomRatio"),
        resolution: document.getElementById("resolutionSelect"),
        fps: document.getElementById("fpsSelect"),
        duration: document.getElementById("durationInput"),
        bitrate: document.getElementById("bitrateRange"),
        bitrateReadout: document.getElementById("bitrateReadout"),
        captureMode: document.getElementById("captureMode"),
        deterministic: document.getElementById("deterministic"),
        summary: document.getElementById("exportSummary"),
      };

      // Aspect ratio buttons
      els.ratioGrid.querySelectorAll(".ratio").forEach((btn) => {
        btn.addEventListener("click", () => {
          els.ratioGrid.querySelectorAll(".ratio").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          setRatio(+btn.dataset.w, +btn.dataset.h);
        });
      });

      // Custom ratio
      els.applyCustom.addEventListener("click", () => {
        const w = +els.customW.value;
        const h = +els.customH.value;
        if (w > 0 && h > 0) {
          els.ratioGrid.querySelectorAll(".ratio").forEach((b) => b.classList.remove("active"));
          setRatio(w, h);
        }
      });

      els.resolution.addEventListener("change", () => {
        state.resolution = +els.resolution.value;
        pushSize();
      });

      els.fps.addEventListener("change", () => {
        state.fps = +els.fps.value;
        updateSummary();
      });

      els.duration.addEventListener("input", () => {
        const v = parseFloat(els.duration.value);
        state.duration = isNaN(v) || v <= 0 ? 0.5 : v;
        updateSummary();
      });

      els.bitrate.addEventListener("input", () => {
        state.bitrateMbps = +els.bitrate.value;
        els.bitrateReadout.textContent = state.bitrateMbps + " Mbps";
        updateSummary();
      });

      els.captureMode.addEventListener("change", () => {
        state.captureMode = els.captureMode.value;
      });

      els.deterministic.addEventListener("change", () => {
        state.deterministic = els.deterministic.checked;
      });

      // Initialise from defaults
      els.resolution.value = String(state.resolution);
      els.fps.value = String(state.fps);
      els.duration.value = String(state.duration);
      els.bitrate.value = String(state.bitrateMbps);
      els.bitrateReadout.textContent = state.bitrateMbps + " Mbps";
      els.captureMode.value = state.captureMode;
      els.deterministic.checked = state.deterministic;

      pushSize();
    },

    get() {
      const { w, h } = computeSize();
      return Object.assign({}, state, {
        width: w,
        height: h,
        frames: Math.round(state.fps * state.duration),
        bitrate: state.bitrateMbps * 1e6,
      });
    },
  };

  window.Settings = Settings;
})();
