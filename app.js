(() => {
  "use strict";

  const ALLOWED_EXT = new Set(["mp3", "m4a"]);
  const ALLOWED_MIME = new Set([
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/x-m4a",
    "audio/m4a",
    "audio/aac",
    "audio/x-mp4",
  ]);

  const els = {
    fileInput: document.getElementById("file-input"),
    dropzone: document.getElementById("dropzone"),
    fileMeta: document.getElementById("file-meta"),
    fileName: document.getElementById("file-name"),
    changeFile: document.getElementById("change-file"),
    controls: document.getElementById("controls"),
    gainBtns: Array.from(document.querySelectorAll(".gain-btn")),
    gainNote: document.getElementById("gain-note"),
    playBtn: document.getElementById("play-btn"),
    iconPlay: document.querySelector(".icon-play"),
    iconPause: document.querySelector(".icon-pause"),
    seek: document.getElementById("seek"),
    currentTime: document.getElementById("current-time"),
    duration: document.getElementById("duration"),
    status: document.getElementById("status"),
    clipWarn: document.getElementById("clip-warn"),
    viz: document.getElementById("viz"),
  };

  /** @type {AudioContext | null} */
  let audioCtx = null;
  /** @type {HTMLAudioElement | null} */
  let audioEl = null;
  /** @type {MediaElementAudioSourceNode | null} */
  let sourceNode = null;
  /** @type {GainNode | null} */
  let gainNode = null;
  /** @type {AnalyserNode | null} */
  let analyser = null;
  /** @type {string | null} */
  let objectUrl = null;
  let currentGain = 2;
  let rafId = 0;
  let seeking = false;

  const vizCtx = els.viz.getContext("2d");
  const freqData = new Uint8Array(64);

  function setStatus(message, isError = false) {
    els.status.textContent = message;
    els.status.classList.toggle("is-error", isError);
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function isAllowedFile(file) {
    if (!file) return false;
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (ALLOWED_EXT.has(ext)) return true;
    if (file.type && ALLOWED_MIME.has(file.type.toLowerCase())) return true;
    return false;
  }

  function ensureAudioGraph() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.preload = "auto";
      audioEl.crossOrigin = "anonymous";

      const syncDuration = () => {
        if (!audioEl) return;
        const d = audioEl.duration;
        if (!Number.isFinite(d) || d === 0) return;
        els.seek.max = String(d);
        els.duration.textContent = formatTime(d);
      };

      audioEl.addEventListener("loadedmetadata", syncDuration);
      audioEl.addEventListener("durationchange", syncDuration);
      audioEl.addEventListener("canplay", syncDuration);

      audioEl.addEventListener("timeupdate", () => {
        if (seeking || !audioEl) return;
        els.seek.value = String(audioEl.currentTime);
        els.currentTime.textContent = formatTime(audioEl.currentTime);
      });

      audioEl.addEventListener("ended", () => {
        setPlayingUI(false);
        stopVizLoop();
        drawIdleViz();
      });

      audioEl.addEventListener("error", () => {
        setStatus("Không phát được file này. Thử file MP3/M4A khác.", true);
        setPlayingUI(false);
      });
    }

    if (!sourceNode) {
      sourceNode = audioCtx.createMediaElementSource(audioEl);
      gainNode = audioCtx.createGain();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.75;

      sourceNode.connect(gainNode);
      gainNode.connect(analyser);
      analyser.connect(audioCtx.destination);
    }

    gainNode.gain.value = currentGain;
  }

  function teardownPlayback() {
    stopVizLoop();
    if (audioEl) {
      audioEl.pause();
      audioEl.removeAttribute("src");
      audioEl.load();
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    setPlayingUI(false);
    els.seek.value = "0";
    els.seek.max = "0";
    els.currentTime.textContent = "0:00";
    els.duration.textContent = "0:00";
    drawIdleViz();
  }

  function setPlayingUI(playing) {
    els.playBtn.classList.toggle("is-playing", playing);
    els.playBtn.setAttribute("aria-label", playing ? "Tạm dừng" : "Phát");
    els.iconPlay.hidden = playing;
    els.iconPause.hidden = !playing;
  }

  function updateGainNote(gain) {
    const label = Number.isInteger(gain) ? String(gain) : String(gain);
    els.gainNote.textContent = `Âm thanh gấp ${label} lần so với gốc`;
    els.clipWarn.hidden = gain < 3;
  }

  function selectGain(gain) {
    currentGain = gain;
    if (gainNode) {
      const now = audioCtx?.currentTime ?? 0;
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setTargetAtTime(gain, now, 0.03);
    }
    els.gainBtns.forEach((btn) => {
      const active = Number(btn.dataset.gain) === gain;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
    });
    updateGainNote(gain);
  }

  async function loadFile(file) {
    if (!isAllowedFile(file)) {
      setStatus("Chỉ hỗ trợ file MP3 hoặc M4A.", true);
      return;
    }

    teardownPlayback();
    ensureAudioGraph();

    objectUrl = URL.createObjectURL(file);
    audioEl.src = objectUrl;

    els.dropzone.classList.add("is-loaded");
    els.fileMeta.hidden = false;
    els.fileName.textContent = file.name;
    els.controls.hidden = false;
    setStatus("Sẵn sàng phát — chọn mức khuếch đại rồi nhấn Phát.");

    try {
      await audioEl.play();
      audioEl.pause();
      audioEl.currentTime = 0;
    } catch {
      // Autoplay may be blocked; user will press play.
    }
  }

  async function togglePlay() {
    if (!audioEl || !audioEl.src) {
      setStatus("Hãy chọn file audio trước.", true);
      return;
    }

    ensureAudioGraph();

    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    if (audioEl.paused) {
      try {
        await audioEl.play();
        setPlayingUI(true);
        startVizLoop();
        setStatus(`Đang phát · ${currentGain}×`);
      } catch {
        setStatus("Trình duyệt chặn phát. Thử nhấn Phát lại.", true);
      }
    } else {
      audioEl.pause();
      setPlayingUI(false);
      stopVizLoop();
      drawIdleViz();
      setStatus("Đã tạm dừng.");
    }
  }

  function drawIdleViz() {
    const canvas = els.viz;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
    }
    vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    vizCtx.clearRect(0, 0, cssW, cssH);

    const bars = 28;
    const gap = 3;
    const barW = (cssW - gap * (bars - 1)) / bars;
    const mid = cssH / 2;

    for (let i = 0; i < bars; i++) {
      const h = 4 + Math.sin(i * 0.45) * 3;
      vizCtx.fillStyle = "rgba(10, 110, 106, 0.22)";
      vizCtx.beginPath();
      vizCtx.roundRect(i * (barW + gap), mid - h / 2, barW, h, 2);
      vizCtx.fill();
    }
  }

  function drawViz() {
    if (!analyser) return;

    analyser.getByteFrequencyData(freqData);
    const canvas = els.viz;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
    }
    vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    vizCtx.clearRect(0, 0, cssW, cssH);

    const bars = 28;
    const gap = 3;
    const barW = (cssW - gap * (bars - 1)) / bars;
    const step = Math.floor(freqData.length / bars);

    for (let i = 0; i < bars; i++) {
      const v = freqData[i * step] / 255;
      const h = Math.max(4, v * cssH * 0.92);
      const y = (cssH - h) / 2;
      const alpha = 0.35 + v * 0.55;
      vizCtx.fillStyle = `rgba(6, 84, 80, ${alpha})`;
      vizCtx.beginPath();
      vizCtx.roundRect(i * (barW + gap), y, barW, h, 2);
      vizCtx.fill();
    }
  }

  function startVizLoop() {
    stopVizLoop();
    const tick = () => {
      drawViz();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopVizLoop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  // Events
  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files?.[0];
    if (file) loadFile(file);
  });

  els.changeFile.addEventListener("click", () => {
    els.fileInput.value = "";
    els.fileInput.click();
  });

  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.fileInput.click();
    }
  });

  ["dragenter", "dragover"].forEach((type) => {
    els.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropzone.classList.add("is-dragover");
    });
  });

  ["dragleave", "drop"].forEach((type) => {
    els.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropzone.classList.remove("is-dragover");
    });
  });

  els.dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });

  els.gainBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      selectGain(Number(btn.dataset.gain));
      if (audioEl && !audioEl.paused) {
        setStatus(`Đang phát · ${currentGain}×`);
      }
    });
  });

  els.playBtn.addEventListener("click", () => {
    togglePlay();
  });

  els.seek.addEventListener("pointerdown", () => {
    seeking = true;
  });

  els.seek.addEventListener("pointerup", () => {
    seeking = false;
  });

  els.seek.addEventListener("input", () => {
    if (!audioEl) return;
    const t = Number(els.seek.value);
    audioEl.currentTime = t;
    els.currentTime.textContent = formatTime(t);
  });

  window.addEventListener("resize", () => {
    if (audioEl && !audioEl.paused) drawViz();
    else drawIdleViz();
  });

  // Init
  selectGain(2);
  drawIdleViz();
  setStatus("");
})();
