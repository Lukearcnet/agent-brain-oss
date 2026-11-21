/**
 * Agent Brain — checkpoint voice support.
 *
 * Read-aloud uses the browser's built-in speech and works anywhere, including
 * plain HTTP. Recording needs a secure origin (HTTPS or localhost), so the mic
 * half is unavailable over a bare LAN/Tailscale IP.
 *
 * Callers own their own buttons; this just reports state back through a
 * callback. Only one checkpoint can speak or record at a time.
 */
(function (global) {
  "use strict";

  var MAX_RECORD_MS = 120000;
  var CHUNK_CHARS = 180;

  // ── Read aloud ────────────────────────────────────────────────────────────

  var speakingKey = null;
  var speakingNotify = null;

  if (global.speechSynthesis) {
    // Voices load asynchronously; warm the list so the first tap has them.
    try {
      global.speechSynthesis.getVoices();
      global.speechSynthesis.onvoiceschanged = function () { global.speechSynthesis.getVoices(); };
    } catch (_) {}
  }

  // Checkpoints are full of markdown, code and file paths that sound awful read
  // aloud. Strip them down to something a voice can actually deliver.
  function plainTextForSpeech(text) {
    var t = String(text || "");
    t = t.replace(/\\n/g, "\n");
    t = t.replace(/```[\s\S]*?```/g, " (code block omitted) ");
    t = t.replace(/^#{1,6}\s+/gm, "");
    t = t.replace(/\*\*(.+?)\*\*/g, "$1");
    t = t.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1");
    t = t.replace(/`([^`]+)`/g, "$1");
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
    t = t.replace(/https?:\/\/\S+/g, "a link");
    // Long paths read as noise — keep just the filename.
    t = t.replace(/(?:\/[\w.@~-]+){2,}/g, function (m) {
      return m.split("/").filter(Boolean).pop();
    });
    t = t.replace(/^\s*[-*•]\s+/gm, "");
    t = t.replace(/[—–]/g, ", ");
    t = t.replace(/\|/g, " ");
    t = t.replace(/\n{2,}/g, "\n");
    t = t.replace(/\s+([,.!?;:])/g, "$1");
    t = t.replace(/[ \t]{2,}/g, " ");
    return t.trim();
  }

  // Short utterances keep Chrome from cutting out mid-sentence and make Stop
  // feel immediate. Split on real sentence ends only, so "dashboard.html"
  // survives intact.
  function chunkForSpeech(text) {
    var parts = text.split(/(?<=[.!?])\s+|\n+/).map(function (p) { return p.trim(); }).filter(Boolean);
    var chunks = [];
    var cur = "";
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part.length > CHUNK_CHARS) {
        // A runaway sentence — break it at word boundaries rather than mid-word.
        if (cur) { chunks.push(cur); cur = ""; }
        var line = "";
        var words = part.split(/\s+/);
        for (var w = 0; w < words.length; w++) {
          if (line && (line + " " + words[w]).length > CHUNK_CHARS) { chunks.push(line); line = words[w]; }
          else line = line ? line + " " + words[w] : words[w];
        }
        cur = line;
        continue;
      }
      if (cur && (cur + " " + part).length > CHUNK_CHARS) { chunks.push(cur); cur = part; }
      else cur = cur ? cur + " " + part : part;
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  function pickVoice() {
    var voices = global.speechSynthesis.getVoices() || [];
    if (!voices.length) return null;
    var preferred = ["Samantha", "Ava", "Alex", "Google US English"];
    for (var i = 0; i < preferred.length; i++) {
      var match = voices.find(function (v) {
        return v.name === preferred[i] || v.name.indexOf(preferred[i]) === 0;
      });
      if (match) return match;
    }
    return voices.find(function (v) { return /^en[-_]US/i.test(v.lang); })
        || voices.find(function (v) { return /^en/i.test(v.lang); })
        || null;
  }

  function canSpeak() { return !!global.speechSynthesis; }
  function isSpeaking() { return speakingKey !== null; }
  function speakingFor() { return speakingKey; }

  function stopSpeaking() {
    var prev = speakingKey;
    var notify = speakingNotify;
    speakingKey = null;
    speakingNotify = null;
    try {
      // Only cancel when something is actually queued — on iOS a cancel()
      // immediately followed by speak() can swallow the new utterance.
      if (global.speechSynthesis.speaking || global.speechSynthesis.pending) {
        global.speechSynthesis.cancel();
      }
    } catch (_) {}
    if (prev && notify) notify(false);
  }

  /**
   * Speak `text`. `key` identifies the checkpoint so a second tap stops it.
   * `onState(speaking)` fires on start and on finish/stop.
   * Must be called directly from a tap — iOS blocks speech otherwise.
   */
  function speak(key, text, onState) {
    if (!canSpeak()) return false;
    if (speakingKey === key) { stopSpeaking(); return false; }
    stopSpeaking();

    var chunks = chunkForSpeech(plainTextForSpeech(text));
    if (!chunks.length) return false;

    var voice = pickVoice();
    speakingKey = key;
    speakingNotify = onState || null;
    if (onState) onState(true);

    chunks.forEach(function (chunk, i) {
      var u = new SpeechSynthesisUtterance(chunk);
      if (voice) u.voice = voice;
      u.lang = (voice && voice.lang) || "en-US";
      u.rate = 1;
      u.pitch = 1;
      if (i === chunks.length - 1) {
        u.onend = function () { if (speakingKey === key) stopSpeaking(); };
      }
      u.onerror = function () { if (speakingKey === key) stopSpeaking(); };
      global.speechSynthesis.speak(u);
    });
    return true;
  }

  // ── Voice replies ─────────────────────────────────────────────────────────

  var recordingKey = null;
  var transcribingKey = null;
  var recorder = null;
  var chunksOut = [];
  var stream = null;
  var timer = null;
  var startedAt = 0;
  var notify = null;

  function canRecord() {
    return !!(global.isSecureContext && global.navigator && navigator.mediaDevices &&
              navigator.mediaDevices.getUserMedia && global.MediaRecorder);
  }

  function isBusy() { return recordingKey !== null || transcribingKey !== null; }
  function recordingFor() { return recordingKey; }

  function pickRecorderMime() {
    // iOS produces audio/mp4; desktop Chrome/Firefox produce webm/ogg.
    var candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    if (!global.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return ""; // let the browser pick
  }

  function releaseMic() {
    if (timer) { clearInterval(timer); timer = null; }
    if (stream) {
      // Without this the OS keeps showing the mic as in use.
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
      stream = null;
    }
  }

  function emit(state) { if (notify) notify(state); }

  /**
   * Toggle recording for `key`. `onState` receives:
   *   {state:"recording", elapsed}  {state:"transcribing"}
   *   {state:"done", text}          {state:"error", message}  {state:"idle"}
   */
  function record(key, onState) {
    if (recordingKey === key) { stopRecording(); return; }
    if (isBusy() || !canRecord()) return;

    notify = onState || null;
    stopSpeaking(); // don't record the read-aloud voice talking over you

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      stream = s;
      chunksOut = [];
      var mime = pickRecorderMime();
      try {
        recorder = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
      } catch (_) {
        recorder = new MediaRecorder(s);
      }

      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunksOut.push(e.data); };
      recorder.onstop = function () { finish(key); };

      recordingKey = key;
      startedAt = Date.now();
      recorder.start();
      emit({ state: "recording", elapsed: 0 });

      timer = setInterval(function () {
        var secs = Math.floor((Date.now() - startedAt) / 1000);
        if (secs * 1000 >= MAX_RECORD_MS) { stopRecording(); return; }
        emit({ state: "recording", elapsed: secs });
      }, 1000);
    }).catch(function () {
      // Hold the callback locally: clearing notify first would make the
      // deferred reset a no-op and strand the button on "Mic blocked".
      var cb = notify;
      emit({ state: "error", message: "Mic blocked" });
      setTimeout(function () { if (cb) cb({ state: "idle" }); notify = null; }, 2500);
    });
  }

  function stopRecording() {
    if (timer) { clearInterval(timer); timer = null; }
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); return; } catch (_) {} // onstop drives finish()
    }
    releaseMic();
    recordingKey = null;
  }

  function finish(key) {
    var type = (recorder && recorder.mimeType) || "audio/webm";
    var blob = new Blob(chunksOut, { type: type });
    chunksOut = [];
    recorder = null;
    releaseMic();
    recordingKey = null;

    if (!blob.size) { emit({ state: "idle" }); notify = null; return; }

    transcribingKey = key;
    emit({ state: "transcribing" });

    var ext = type.indexOf("mp4") >= 0 ? "mp4" : type.indexOf("ogg") >= 0 ? "ogg" : "webm";
    var form = new FormData();
    form.append("audio", blob, "reply." + ext);

    fetch("/api/transcribe", { method: "POST", body: form })
      .then(function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (data) {
          return { ok: resp.ok, data: data };
        });
      })
      .then(function (r) {
        if (!r.ok || !r.data.ok) {
          emit({ state: "error", message: r.data.error || "Transcription failed" });
          setTimeout(function () { emit({ state: "idle" }); notify = null; }, 4000);
          return;
        }
        emit({ state: "done", text: String(r.data.text || "").trim() });
        notify = null;
      })
      .catch(function (e) {
        emit({ state: "error", message: e.message || "Transcription failed" });
        setTimeout(function () { emit({ state: "idle" }); notify = null; }, 4000);
      })
      .then(function () { transcribingKey = null; });
  }

  global.addEventListener("pagehide", function () {
    try { stopSpeaking(); } catch (_) {}
    try { stopRecording(); } catch (_) {}
  });

  global.ABVoice = {
    canSpeak: canSpeak,
    speak: speak,
    stopSpeaking: stopSpeaking,
    isSpeaking: isSpeaking,
    speakingFor: speakingFor,
    canRecord: canRecord,
    insecureOrigin: function () { return !!global.MediaRecorder && !global.isSecureContext; },
    record: record,
    stopRecording: stopRecording,
    isBusy: isBusy,
    recordingFor: recordingFor,
    // exported for tests
    _plainTextForSpeech: plainTextForSpeech,
    _chunkForSpeech: chunkForSpeech
  };
})(window);
