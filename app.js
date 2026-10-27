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
  /** @type {GainNode | null} */
  let gainNode = null;
  /** @type {AnalyserNode | null} */
  let analyser = null;
  /** @type {AudioBuffer | null} */
  let audioBuffer = null;
  /** @type {AudioBufferSourceNode | null} */
  let bufferSource = null;

  let currentGain = 2;
  let isPlaying = false;
  let pauseOffset = 0;
  let startedAtCtxTime = 0;
  let seeking = false;
  let rafId = 0;
  let loadToken = 0;

  const vizCtx = els.viz.getContext("2d");
  let freqData = new Uint8Array(64);

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

  function getAudioContextClass() {
    return window.AudioContext || window.webkitAudioContext || null;
  }

  async function ensureAudioGraph() {
    const Ctx = getAudioContextClass();
    if (!Ctx) {
      throw new Error("Trình duyệt không hỗ trợ Web Audio API.");
    }

    if (!audioCtx) {
      audioCtx = new Ctx();
      gainNode = audioCtx.createGain();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      freqData = new Uint8Array(analyser.frequencyBinCount);

      gainNode.connect(analyser);
      analyser.connect(audioCtx.destination);
      gainNode.gain.value = currentGain;
    }

    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    return audioCtx;
  }

  function getPlaybackTime() {
    if (!audioBuffer) return 0;
    if (!isPlaying || !audioCtx) return pauseOffset;
    const t = pauseOffset + (audioCtx.currentTime - startedAtCtxTime);
    return Math.min(audioBuffer.duration, Math.max(0, t));
  }

  function stopSourceNode() {
    if (!bufferSource) return;
    bufferSource.onended = null;
    try {
      bufferSource.stop(0);
    } catch {
      // already stopped
    }
    try {
      bufferSource.disconnect();
    } catch {
      // ignore
    }
    bufferSource = null;
  }

  function teardownPlayback() {
    stopVizLoop();
    stopSourceNode();
    isPlaying = false;
    pauseOffset = 0;
    startedAtCtxTime = 0;
    audioBuffer = null;
    setPlayingUI(false);
    els.seek.value = "0";
    els.seek.max = "0";
    els.currentTime.textContent = "0:00";
    els.duration.textContent = "0:00";
    els.playBtn.disabled = true;
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
    if (gainNode && audioCtx) {
      const now = audioCtx.currentTime;
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(gainNode.gain.value, now);
      gainNode.gain.linearRampToValueAtTime(gain, now + 0.04);
    }
    els.gainBtns.forEach((btn) => {
      const active = Number(btn.dataset.gain) === gain;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
    });
    updateGainNote(gain);
    if (isPlaying) setStatus(`Đang phát · ${currentGain}×`);
  }

  async function decodeFile(file) {
    const ctx = await ensureAudioGraph();
    const arrayBuffer = await file.arrayBuffer();
    // copy: decodeAudioData may detach the buffer
    const copy = arrayBuffer.slice(0);
    return await new Promise((resolve, reject) => {
      const onFail = (err) => reject(err || new Error("decode failed"));
      try {
        const result = ctx.decodeAudioData(copy, resolve, onFail);
        if (result && typeof result.then === "function") {
          result.then(resolve, onFail);
        }
      } catch (err) {
        onFail(err);
      }
    });
  }

  async function loadFile(file) {
    if (!isAllowedFile(file)) {
      setStatus("Chỉ hỗ trợ file MP3 hoặc M4A.", true);
      return;
    }

    const token = ++loadToken;
    teardownPlayback();
    setStatus("Đang giải mã file…");
    els.playBtn.disabled = true;

    try {
      // Unlock audio on this user gesture (file picker / drop)
      await ensureAudioGraph();
      const buffer = await decodeFile(file);
      if (token !== loadToken) return;

      audioBuffer = buffer;
      pauseOffset = 0;
      els.seek.max = String(buffer.duration);
      els.seek.value = "0";
      els.duration.textContent = formatTime(buffer.duration);
      els.currentTime.textContent = "0:00";
      els.playBtn.disabled = false;

      els.dropzone.classList.add("is-loaded");
      els.fileMeta.hidden = false;
      els.fileName.textContent = file.name;
      els.controls.hidden = false;
      setStatus("Sẵn sàng phát — chọn mức khuếch đại rồi nhấn Phát.");
    } catch (err) {
      console.error(err);
      if (token !== loadToken) return;
      teardownPlayback();
      setStatus("Không giải mã được file. Thử MP3/M4A khác hoặc trình duyệt khác.", true);
    }
  }

  function startBufferSource(offsetSec) {
    if (!audioCtx || !audioBuffer || !gainNode) return;

    stopSourceNode();

    const offset = Math.min(Math.max(0, offsetSec), Math.max(0, audioBuffer.duration - 0.01));
    bufferSource = audioCtx.createBufferSource();
    bufferSource.buffer = audioBuffer;
    bufferSource.connect(gainNode);
    gainNode.gain.setValueAtTime(currentGain, audioCtx.currentTime);

    bufferSource.onended = () => {
      // Ignore stop() from pause/seek — only natural end
      if (!isPlaying) return;
      const nearEnd = getPlaybackTime() >= audioBuffer.duration - 0.05;
      if (!nearEnd) return;
      isPlaying = false;
      pauseOffset = 0;
      startedAtCtxTime = 0;
      bufferSource = null;
      setPlayingUI(false);
      stopVizLoop();
      els.seek.value = "0";
      els.currentTime.textContent = "0:00";
      drawIdleViz();
      setStatus("Đã phát xong.");
    };

    pauseOffset = offset;
    startedAtCtxTime = audioCtx.currentTime;
    isPlaying = true;
    bufferSource.start(0, offset);
  }

  async function togglePlay() {
    if (!audioBuffer) {
      setStatus("Hãy chọn file audio trước.", true);
      return;
    }

    try {
      await ensureAudioGraph();
    } catch (err) {
      setStatus(err.message || "Không mở được audio.", true);
      return;
    }

    if (!isPlaying) {
      try {
        startBufferSource(pauseOffset >= audioBuffer.duration ? 0 : pauseOffset);
        setPlayingUI(true);
        startUiClock();
        startVizLoop();
        setStatus(`Đang phát · ${currentGain}×`);
      } catch (err) {
        console.error(err);
        isPlaying = false;
        setPlayingUI(false);
        setStatus("Không phát được. Thử nhấn Phát lại.", true);
      }
      return;
    }

    // Pause
    pauseOffset = getPlaybackTime();
    isPlaying = false;
    stopSourceNode();
    setPlayingUI(false);
    stopVizLoop();
    stopUiClock();
    drawIdleViz();
    els.seek.value = String(pauseOffset);
    els.currentTime.textContent = formatTime(pauseOffset);
    setStatus("Đã tạm dừng.");
  }

  function seekTo(seconds) {
    if (!audioBuffer) return;
    const t = Math.min(Math.max(0, seconds), audioBuffer.duration);
    pauseOffset = t;
    els.seek.value = String(t);
    els.currentTime.textContent = formatTime(t);
    if (isPlaying) {
      startBufferSource(t);
    }
  }

  let uiClockId = 0;
  function startUiClock() {
    stopUiClock();
    const tick = () => {
      if (!isPlaying || seeking) {
        uiClockId = requestAnimationFrame(tick);
        return;
      }
      const t = getPlaybackTime();
      els.seek.value = String(t);
      els.currentTime.textContent = formatTime(t);
      uiClockId = requestAnimationFrame(tick);
    };
    uiClockId = requestAnimationFrame(tick);
  }

  function stopUiClock() {
    if (uiClockId) {
      cancelAnimationFrame(uiClockId);
      uiClockId = 0;
    }
  }

  function drawIdleViz() {
    const canvas = els.viz;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 320;
    const cssH = canvas.clientHeight || 56;
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
      roundRectFill(i * (barW + gap), mid - h / 2, barW, h);
    }
  }

  function roundRectFill(x, y, w, h) {
    if (typeof vizCtx.roundRect === "function") {
      vizCtx.beginPath();
      vizCtx.roundRect(x, y, w, h, 2);
      vizCtx.fill();
      return;
    }
    vizCtx.fillRect(x, y, w, h);
  }

  function drawViz() {
    if (!analyser) return;

    analyser.getByteFrequencyData(freqData);
    const canvas = els.viz;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 320;
    const cssH = canvas.clientHeight || 56;
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
    }
    vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    vizCtx.clearRect(0, 0, cssW, cssH);

    const bars = 28;
    const gap = 3;
    const barW = (cssW - gap * (bars - 1)) / bars;
    const step = Math.max(1, Math.floor(freqData.length / bars));

    for (let i = 0; i < bars; i++) {
      const v = freqData[i * step] / 255;
      const h = Math.max(4, v * cssH * 0.92);
      const y = (cssH - h) / 2;
      const alpha = 0.35 + v * 0.55;
      vizCtx.fillStyle = `rgba(6, 84, 80, ${alpha})`;
      roundRectFill(i * (barW + gap), y, barW, h);
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
    });
  });

  els.playBtn.addEventListener("click", () => {
    togglePlay();
  });

  els.seek.addEventListener("pointerdown", () => {
    seeking = true;
  });

  const endSeek = () => {
    if (!seeking) return;
    seeking = false;
    seekTo(Number(els.seek.value));
  };

  els.seek.addEventListener("pointerup", endSeek);
  els.seek.addEventListener("change", endSeek);

  els.seek.addEventListener("input", () => {
    const t = Number(els.seek.value);
    els.currentTime.textContent = formatTime(t);
    if (!seeking) seekTo(t);
  });

  window.addEventListener("resize", () => {
    if (isPlaying) drawViz();
    else drawIdleViz();
  });

  // Unlock audio early on first tap anywhere (helps iOS)
  const unlockOnce = async () => {
    try {
      await ensureAudioGraph();
    } catch {
      // ignore until play
    }
    window.removeEventListener("pointerdown", unlockOnce);
    window.removeEventListener("touchstart", unlockOnce);
  };
  window.addEventListener("pointerdown", unlockOnce, { passive: true });
  window.addEventListener("touchstart", unlockOnce, { passive: true });

  // Init
  els.playBtn.disabled = true;
  selectGain(2);
  drawIdleViz();
  setStatus("");
})();
