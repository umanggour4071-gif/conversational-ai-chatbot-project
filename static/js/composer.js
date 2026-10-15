// The message composer: auto-growing input, send rules, attachments (picker, drag and drop,
// paste), the microphone and its listening indicator.
import { autoGrow } from "./ui.js";
import { createAttachments } from "./attachments.js";
import { createVoiceInput, UNSUPPORTED_MESSAGE } from "./voice.js";

export function createComposer({ root, limits, toaster, SpeechRecognition, lang, urlApi = URL, onSubmit }) {
  const doc = root.ownerDocument || root; // accepts a Document or any element
  const $ = (id) => doc.getElementById(id);
  const form = $("composer"), input = $("message-input"), sendBtn = $("send-btn");
  const attachBtn = $("attach-btn"), fileInput = $("file-input"), micBtn = $("mic-btn");
  const status = $("composer-status"), indicator = $("listening-indicator"), counter = $("char-count");
  const overlay = $("drop-overlay");
  let busy = false;

  const attachments = createAttachments({
    trayEl: $("attachment-tray"), listEl: $("attachment-list"),
    maxImages: limits.maxImages, maxBytes: limits.maxImageMb * 1024 * 1024, urlApi,
    onChange: () => refresh(), onError: (m) => toaster.error(m),
  });

  // ---- send state -----------------------------------------------------------
  const length = () => input.value.trim().length;
  const overLimit = () => length() > limits.maxChars;

  function refresh() {
    const hasContent = length() > 0 || attachments.count > 0;
    sendBtn.disabled = busy || !hasContent || overLimit();
    const show = length() > limits.maxChars * 0.8;
    counter.hidden = !show;
    counter.textContent = `${length()} / ${limits.maxChars}`;
    counter.classList.toggle("is-over", overLimit());
    if (!voice.listening) setStatus(busy ? "Waiting for the assistant\u2026" : overLimit() ? `Message is over the ${limits.maxChars}-character limit.` : "", overLimit());
  }

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.classList.toggle("is-error", isError);
  }

  function submit() {
    if (busy || sendBtn.disabled) {
      if (overLimit()) toaster.error(`Message is too long (max ${limits.maxChars} characters).`);
      return;
    }
    voice.abort(); // keep what is already in the box; drop anything still being recognised
    const payload = { text: input.value.trim(), files: attachments.files() };
    input.value = "";
    attachments.clear();
    autoGrow(input);
    refresh();
    onSubmit(payload);
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  input.addEventListener("input", () => { autoGrow(input); refresh(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
  });

  // ---- attachments ------------------------------------------------------------
  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { attachments.add(fileInput.files); fileInput.value = ""; input.focus(); });

  input.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); attachments.add(files); }
  });

  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
  let dragDepth = 0;
  const setDrag = (on) => { overlay.hidden = !on; form.classList.toggle("is-dragover", on); };
  $("drop-sub").textContent = `JPEG, PNG or WebP \u00b7 up to ${limits.maxImages} images, ${limits.maxImageMb} MB each`;

  doc.addEventListener("dragenter", (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth += 1; setDrag(true); } });
  doc.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; } });
  doc.addEventListener("dragleave", (e) => { if (hasFiles(e)) { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) setDrag(false); } });
  doc.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // otherwise the browser would navigate to the dropped file
    dragDepth = 0; setDrag(false);
    attachments.add(e.dataTransfer.files);
    input.focus();
  });

  // ---- voice input --------------------------------------------------------------
  const voice = createVoiceInput({
    SpeechRecognition, textarea: input, lang,
    onState(state) {
      const on = state !== "idle";
      micBtn.setAttribute("aria-pressed", String(on));
      const label = on ? "Stop voice input" : "Start voice input";
      micBtn.setAttribute("aria-label", label); micBtn.title = label;
      form.classList.toggle("is-listening", state === "listening");
      indicator.hidden = state !== "listening";
      if (state === "starting") setStatus("Waiting for microphone\u2026");
      else if (state === "listening") setStatus("Listening\u2026 click the microphone to stop");
      else { setStatus(""); refresh(); input.focus(); }
    },
    onError({ message }) { toaster.error(message); },
  });

  if (!voice.supported) {
    micBtn.setAttribute("aria-disabled", "true");
    micBtn.title = UNSUPPORTED_MESSAGE;
    micBtn.setAttribute("aria-label", "Voice input (not supported in this browser)");
  } else if (doc.defaultView.isSecureContext === false) {
    micBtn.title = "Voice input needs HTTPS or localhost.";
  }
  micBtn.addEventListener("click", () => {
    if (!voice.supported) { toaster.error(UNSUPPORTED_MESSAGE); return; }
    if (doc.defaultView.isSecureContext === false) { toaster.error("Voice input only works on HTTPS or localhost."); return; }
    voice.toggle();
  });

  refresh();
  return {
    attachments, voice,
    focus: () => input.focus(),
    stopVoice: () => voice.abort(),
    setText(text) { input.value = text; autoGrow(input); refresh(); },
    setBusy(value) { busy = value; form.setAttribute("aria-busy", String(value)); refresh(); },
    openFilePicker: () => fileInput.click(),
    text: () => input.value,
  };
}
