/* =======================================================================
 * app.js — Wires the modules together: live preview, export flow,
 * progress overlay, cancellation and download.
 * ===================================================================== */
(function () {
  "use strict";

  let exporting = false;
  let cancelled = false;

  const el = {};

  function $(id) {
    return document.getElementById(id);
  }

  function toast(msg, kind, ms) {
    const t = el.toast;
    t.textContent = msg;
    t.className = "toast" + (kind ? " " + kind : "");
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.hidden = true), ms || 3500);
  }

  function showOverlay(show) {
    el.overlay.hidden = !show;
  }

  function setProgress(fraction, label, sub) {
    el.progressBar.style.width = Math.round(fraction * 100) + "%";
    if (label) el.renderLabel.textContent = label;
    el.renderSub.textContent =
      sub != null ? sub : Math.round(fraction * 100) + "%";
  }

  function refreshPreview() {
    const project = window.Editor.getProject();
    window.Preview.render(project).then(() => {
      // Surface runtime errors flagged by the preview harness via document.title.
      try {
        const doc = window.Preview.doc();
        if (doc && /^ERROR:/.test(doc.title)) {
          toast(doc.title, "err", 5000);
        }
      } catch (e) { /* cross-origin guard */ }
    });
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function timestampName(ext) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return (
      "video_" +
      d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
      "." + ext
    );
  }

  async function startExport() {
    if (exporting) return;

    const caps = window.Recorder.detectCapabilities();
    if (caps.mode === "none") {
      toast("This browser has no usable video encoder. Try Chrome or Edge.", "err", 6000);
      return;
    }

    const settings = window.Settings.get();
    if (!(settings.frames > 0)) {
      toast("Duration is too short.", "err");
      return;
    }

    exporting = true;
    cancelled = false;
    el.exportBtn.disabled = true;
    el.runBtn.disabled = true;
    showOverlay(true);
    setProgress(0, "Preparing scene", "");

    const started = performance.now();

    // Watchdog: if progress doesn't advance for a long time, fail loudly
    // instead of freezing the UI forever.
    let lastProgressAt = performance.now();
    let watchdogTripped = false;
    const watchdog = setInterval(() => {
      if (performance.now() - lastProgressAt > 20000) {
        watchdogTripped = true;
        cancelled = true;
      }
    }, 2000);

    try {
      const result = await window.Recorder.export({
        project: window.Editor.getProject(),
        settings,
        onProgress: (f, label, sub) => {
          lastProgressAt = performance.now();
          setProgress(f, label, sub);
        },
        isCancelled: () => cancelled,
      });

      if (watchdogTripped) {
        toast("Export stalled and was stopped. Try Canvas capture mode, a shorter duration, or a lower resolution.", "err", 8000);
      } else if (cancelled) {
        toast("Export cancelled.", null);
      } else {
        const filename = timestampName(result.ext);
        download(result.blob, filename);
        const secs = ((performance.now() - started) / 1000).toFixed(1);
        const sizeMB = (result.blob.size / 1024 / 1024).toFixed(1);
        const note =
          result.ext === "mp4"
            ? "Exported " + filename + " (" + sizeMB + " MB) in " + secs + "s"
            : "Exported " + filename + " (" + sizeMB + " MB). MP4 wasn't supported here, so a WebM was produced.";
        toast(note, "ok", 6000);
      }
    } catch (err) {
      console.error(err);
      toast("Export failed: " + (err && err.message ? err.message : err), "err", 7000);
    } finally {
      clearInterval(watchdog);
      exporting = false;
      el.exportBtn.disabled = false;
      el.runBtn.disabled = false;
      showOverlay(false);
      setProgress(0, "Rendering…", "0%");
      // Restore the live (animated) preview.
      refreshPreview();
    }
  }

  function initCapabilityBadge() {
    const caps = window.Recorder.detectCapabilities();
    el.badge.textContent = caps.label;
    el.badge.classList.remove("good", "warn");
    if (caps.mode === "webcodecs") el.badge.classList.add("good");
    else if (caps.mode === "mediarecorder") el.badge.classList.add("warn");
    else el.badge.classList.add("warn");

    if (caps.mode === "mediarecorder") {
      el.badge.title =
        "WebCodecs isn't available here, so export uses real-time MediaRecorder. For true high-quality MP4, use a recent Chrome or Edge.";
    } else if (caps.mode === "none") {
      el.badge.title = "No video encoder available in this browser.";
    }
  }

  function init() {
    el.toast = $("toast");
    el.overlay = $("renderOverlay");
    el.progressBar = $("progressBar");
    el.renderLabel = $("renderLabel");
    el.renderSub = $("renderSub");
    el.exportBtn = $("exportBtn");
    el.runBtn = $("runBtn");
    el.cancelBtn = $("cancelBtn");
    el.badge = $("capabilityBadge");

    // Order matters: Preview before Settings (Settings pushes a render size).
    window.Preview.init();
    window.Editor.init(() => refreshPreview());
    window.Settings.init(() => window.Preview.refit());

    initCapabilityBadge();

    el.runBtn.addEventListener("click", refreshPreview);
    el.exportBtn.addEventListener("click", startExport);
    el.cancelBtn.addEventListener("click", () => {
      cancelled = true;
      el.renderLabel.textContent = "Cancelling…";
    });

    // Ctrl/Cmd + Enter re-runs the preview.
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        refreshPreview();
      }
    });

    // First render.
    refreshPreview();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
