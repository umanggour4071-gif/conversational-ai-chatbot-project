// Voice input via the browser's SpeechRecognition. Recognised text is inserted into the message
// box (at the caret) so the user can edit it before sending. Nothing is sent automatically.

const ERRORS = {
  "not-allowed": "Microphone access is blocked. Allow it in your browser's site settings, then try again.",
  "service-not-allowed": "Microphone access is blocked. Allow it in your browser's site settings, then try again.",
  "no-speech": "No speech detected. Click the microphone and try again.",
  "audio-capture": "No microphone was found. Connect one and try again.",
  "network": "Speech recognition needs an internet connection in this browser.",
  "language-not-supported": "This browser can't recognise speech in your language.",
};

export const UNSUPPORTED_MESSAGE = "Voice input isn't supported in this browser. Try Chrome, Edge or Safari.";

export function describeVoiceError(code) {
  return ERRORS[code] || `Voice input stopped (${code || "unknown error"}). Please try again.`;
}

export function createVoiceInput({ SpeechRecognition, textarea, lang = "en-US", onState = () => {}, onError = () => {} }) {
  const supported = Boolean(SpeechRecognition);
  let recognition = null;
  let state = "idle"; // idle -> starting -> listening -> idle
  let prefix = "", suffix = "", finalText = "", lastInterim = "";
  let internalInput = false;
  let stopTimer = null;

  function setState(next) { if (state !== next) { state = next; onState(next); } }

  function render(interim) {
    const spoken = (finalText + interim).replace(/^\s+/, "");
    const left = prefix && spoken && !/\s$/.test(prefix) ? prefix + " " : prefix;
    const right = suffix && spoken && !/^\s/.test(suffix) ? " " + suffix : suffix;
    textarea.value = left + spoken + right;
    const caret = (left + spoken).length;
    try { textarea.setSelectionRange(caret, caret); } catch { /* not focusable yet */ }
    internalInput = true;
    const EventCtor = textarea.ownerDocument.defaultView?.Event || Event;
    textarea.dispatchEvent(new EventCtor("input", { bubbles: true }));
    internalInput = false;
  }

  function finish() {
    clearTimeout(stopTimer);
    if (recognition) { recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null; }
    recognition = null;
    setState("idle");
  }

  // Typing while dictating would fight with our inserts, so typing ends dictation.
  textarea.addEventListener("input", () => { if (!internalInput && state !== "idle") stop(); });

  function start() {
    if (!supported) { onError({ code: "unsupported", message: UNSUPPORTED_MESSAGE }); return false; }
    if (state !== "idle") return false;
    const value = textarea.value;
    const from = textarea.selectionStart ?? value.length;
    const to = textarea.selectionEnd ?? from;
    prefix = value.slice(0, from); suffix = value.slice(to); finalText = ""; lastInterim = "";

    recognition = new SpeechRecognition();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => setState("listening");
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript; else interim += result[0].transcript;
      }
      lastInterim = interim;
      render(interim);
    };
    recognition.onerror = (event) => {
      if (event.error === "aborted") return;
      onError({ code: event.error, message: describeVoiceError(event.error) });
    };
    // Keep words the user already saw in the box even if the engine ended without finalising them.
    recognition.onend = () => { finalText += lastInterim; lastInterim = ""; render(""); finish(); };

    setState("starting");
    try {
      recognition.start();
    } catch {
      finish();
      onError({ code: "start-failed", message: "Couldn't start voice input. Please try again." });
      return false;
    }
    return true;
  }

  function stop() {
    if (!recognition || state === "idle") return;
    try { recognition.stop(); } catch { /* already stopped */ }
    // Safety net: some engines never fire "end" after stop().
    stopTimer = setTimeout(() => {
      if (!recognition) return;
      try { recognition.abort(); } catch { /* ignore */ }
      finalText += lastInterim; lastInterim = ""; render(""); finish();
    }, 2500);
  }

  /** Stop immediately and discard any pending results (used when the message is sent or the chat changes). */
  function abort() {
    if (!recognition) return;
    const rec = recognition;
    finish(); // detach handlers first so no late result re-fills the textarea
    try { rec.abort(); } catch { /* ignore */ }
  }

  function toggle() { return state === "idle" ? start() : (stop(), false); }

  return { supported, start, stop, abort, toggle, get state() { return state; }, get listening() { return state !== "idle"; } };
}
