// Wires every module together. `initApp` takes its browser dependencies as arguments so the
// same code runs in a real page and in the jsdom integration tests.
import { createApi } from "./api.js";
import { createToaster, createConfirm } from "./ui.js";
import { createMarkdownRenderer } from "./markdown.js";
import { createSpeaker } from "./speech.js";
import { createMessageView } from "./messages.js";
import { createSidebar, createDrawer } from "./sidebar.js";
import { createComposer } from "./composer.js";

const LAST_KEY = "chatbot:lastConversation";

export function initApp({ document: doc, window: win, fetch: fetchFn }) {
  const $ = (id) => doc.getElementById(id);
  const num = (value, fallback) => (Number.isFinite(parseInt(value, 10)) ? parseInt(value, 10) : fallback);
  const limits = {
    maxImages: num(doc.body.dataset.maxImages, 4),
    maxImageMb: num(doc.body.dataset.maxImageMb, 5),
    maxChars: num(doc.body.dataset.maxChars, 4000),
  };
  const lang = win.navigator.language || "en-US";
  const store = {
    get() { try { return win.localStorage.getItem(LAST_KEY); } catch { return null; } },
    set(v) { try { v ? win.localStorage.setItem(LAST_KEY, v) : win.localStorage.removeItem(LAST_KEY); } catch { /* private mode */ } },
  };

  const state = { conversationId: null, busy: false, view: 0 };
  const thread = $("thread"), titleEl = $("chat-title"), stopBtn = $("stop-speaking-btn");

  const toaster = createToaster($("toasts"));
  const api = createApi({ fetchFn, csrfToken: () => doc.querySelector('meta[name="csrf-token"]').content });
  const markdown = createMarkdownRenderer({ marked: win.marked, purify: win.DOMPurify, doc });

  let view; // assigned below; the speaker callback needs it
  const speaker = createSpeaker({
    synth: win.speechSynthesis, Utterance: win.SpeechSynthesisUtterance, lang,
    onChange(s) { stopBtn.hidden = !s.speaking; view?.syncSpeaking(s); },
    onError: (m) => toaster.error(m),
  });
  stopBtn.addEventListener("click", () => speaker.stop());

  view = createMessageView({
    listEl: $("messages"), threadEl: thread, markdown, speaker, urlApi: win.URL, toaster,
    onRetry: (handle) => retry(handle), onDiscard: () => {},
  });

  const drawer = createDrawer({ sidebar: $("sidebar"), scrim: $("scrim"), menuBtn: $("menu-btn"), closeBtn: $("sidebar-close-btn") });
  const sidebar = createSidebar({
    listEl: $("conversation-list"), emptyEl: $("conversation-empty"), errorEl: $("conversation-error"),
    api, toaster, confirm: createConfirm($("confirm-dialog")),
    onSelect: (id) => { drawer.close({ restoreFocus: false }); if (id !== state.conversationId) loadConversation(id); },
    onDeleted: (id) => { if (id === state.conversationId) newChat(); },
    onRenamed: (id, title) => { if (id === state.conversationId) titleEl.textContent = title; },
  });

  const composer = createComposer({
    root: doc, limits, toaster, lang, urlApi: win.URL,
    SpeechRecognition: win.SpeechRecognition || win.webkitSpeechRecognition,
    onSubmit: ({ text, files }) => send({ text, files }),
  });

  // ---- sending ----------------------------------------------------------------
  function setBusy(value) { state.busy = value; composer.setBusy(value); }

  async function send({ text, files }, existing = null) {
    if (state.busy) return;
    speaker.stop();
    const viewAtSend = state.view;
    const bubble = existing || view.addUser({ text, files, status: "sending" });
    if (existing) bubble.markSending();
    const thinking = view.addThinking();
    setBusy(true);
    bubble.payload = { text, files };
    try {
      const res = await api.sendMessage({ message: text, conversationId: state.conversationId, files });
      sidebar.touch(res.conversation_id, res.title);
      if (viewAtSend !== state.view) return; // the user moved to another chat while we waited
      thinking.remove();
      bubble.markSent();
      state.conversationId = res.conversation_id;
      store.set(res.conversation_id);
      titleEl.textContent = res.title;
      sidebar.setActive(res.conversation_id);
      view.addAssistant({ content: res.message.content });
    } catch (err) {
      thinking.remove();
      if (viewAtSend === state.view) bubble.markFailed(err.message);
    } finally {
      setBusy(false);
      if (viewAtSend === state.view) composer.focus();
    }
  }

  function retry(bubble) {
    if (state.busy) { toaster.error("Please wait for the current reply first."); return; }
    send(bubble.payload, bubble);
  }

  // ---- conversations ------------------------------------------------------------
  function resetView() {
    state.view += 1;
    speaker.stop();
    composer.stopVoice();
    view.clear();
  }

  function newChat() {
    resetView();
    state.conversationId = null;
    store.set(null);
    titleEl.textContent = "New chat";
    sidebar.setActive(null);
    drawer.close({ restoreFocus: false });
    composer.focus();
  }

  async function loadConversation(id) {
    resetView();
    const mine = state.view;
    thread.setAttribute("aria-busy", "true");
    try {
      const conv = await api.getConversation(id);
      if (mine !== state.view) return;
      state.conversationId = conv.id;
      store.set(conv.id);
      titleEl.textContent = conv.title;
      sidebar.setActive(conv.id);
      for (const m of conv.messages) {
        if (m.role === "user") view.addUser({ text: m.content, meta: m.images });
        else view.addAssistant({ content: m.content });
      }
      view.scrollToBottom();
      composer.focus();
    } catch (err) {
      if (mine !== state.view) return;
      toaster.error(err.status === 404 ? "That conversation no longer exists." : err.message);
      await sidebar.refresh();
      newChat();
    } finally {
      thread.removeAttribute("aria-busy");
    }
  }

  // ---- welcome screen + chrome ------------------------------------------------
  $("starters").addEventListener("click", (event) => {
    const btn = event.target.closest(".starter");
    if (!btn) return;
    if (btn.dataset.action === "attach") { composer.openFilePicker(); return; }
    composer.setText(btn.dataset.prompt || "");
    composer.focus();
  });
  $("new-chat-btn").addEventListener("click", newChat);
  win.addEventListener("pagehide", () => { speaker.stop(); composer.stopVoice(); });

  // ---- start ------------------------------------------------------------------
  (async function start() {
    await sidebar.refresh();
    const last = store.get();
    if (last && sidebar.has(last)) await loadConversation(last);
    else { store.set(null); composer.focus(); }
  })();

  return { state, api, composer, sidebar, view, speaker, newChat, loadConversation, drawer };
}
