// Integration: the real template + every real module wired together by initApp(), talking to a
// fake in-memory API that mimics the Flask endpoints (this is a test double, not app code).
import test from "node:test";
import assert from "node:assert/strict";
import { initApp } from "../../static/js/app.js";
import { loadPage, $, waitFor, png, FakeRecognition } from "./helpers.mjs";

function fakeBackend() {
  const convs = new Map(); let seq = 0; const calls = []; let failNext = null;
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  async function fetchFn(url, init = {}) {
    const method = init.method || "GET";
    calls.push({ url, method, headers: init.headers, body: init.body });
    const m = url.match(/^\/api\/conversations\/?([^/]*)$/);
    if (url === "/api/chat") {
      if (failNext) { const f = failNext; failNext = null; return reply({ error: f.error }, f.status); }
      const form = init.body;
      const text = form.get("message"); const files = form.getAll("images");
      let id = form.get("conversation_id");
      if (id && !convs.has(id)) return reply({ error: "Conversation not found." }, 404);
      if (!id) { id = `c${++seq}`; convs.set(id, { id, title: text.slice(0, 40) || "Image conversation", messages: [] }); }
      const c = convs.get(id);
      const user = { id: c.messages.length + 1, role: "user", content: text, images: files.map((f) => ({ name: f.name, type: f.type, size: f.size, width: 10, height: 10 })) };
      const asst = { id: c.messages.length + 2, role: "assistant", content: `Reply to: **${text || "(image)"}**` };
      c.messages.push(user, asst);
      return reply({ conversation_id: id, title: c.title, user_message: user, message: asst });
    }
    if (m && !m[1]) return reply({ conversations: [...convs.values()].reverse().map(({ id, title }) => ({ id, title })) });
    if (m && method === "GET") return convs.has(m[1]) ? reply({ ...convs.get(m[1]) }) : reply({ error: "Conversation not found." }, 404);
    if (m && method === "PATCH") { const t = JSON.parse(init.body).title; convs.get(m[1]).title = t; return reply({ id: m[1], title: t }); }
    if (m && method === "DELETE") { convs.delete(m[1]); return reply({ deleted: true }); }
    return reply({ error: "unexpected" }, 500);
  }
  return { fetchFn, convs, calls, failNext(status, error) { failNext = { status, error }; }, seed(title, messages) { const id = `c${++seq}`; convs.set(id, { id, title, messages }); return id; } };
}

async function boot(opts = {}, backend = fakeBackend()) {
  const page = loadPage(opts);
  const app = initApp({ document: page.document, window: page.window, fetch: backend.fetchFn });
  await waitFor(() => !page.document.querySelector(".conv-skeleton") && !page.document.querySelector("[aria-busy=true]"), { label: "initial load" });
  const d = page.document;
  return { ...page, app, backend, d,
    type: (t) => { const i = $(d, "message-input"); i.value = t; i.dispatchEvent(new page.window.Event("input", { bubbles: true })); },
    submit: () => $(d, "composer").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true })),
    replies: () => d.querySelectorAll(".msg-assistant .prose").length,
  };
}

test("starts on the welcome screen with sensible control state", async () => {
  const t = await boot();
  assert.equal($(t.d, "thread").classList.contains("has-messages"), false);
  assert.equal($(t.d, "send-btn").disabled, true);
  assert.equal($(t.d, "conversation-empty").hidden, false);
  assert.equal($(t.d, "chat-title").textContent, "New chat");
});

test("sending text renders both messages, Markdown, sidebar entry, and keeps context", async () => {
  const t = await boot();
  t.type("Use *stars* literally");
  assert.equal($(t.d, "send-btn").disabled, false);
  t.submit();
  await waitFor(() => t.replies() === 1, { label: "assistant reply" });
  assert.equal(t.d.querySelector(".msg-user .msg-text").textContent, "Use *stars* literally", "user text is shown literally");
  assert.equal(t.d.querySelector(".msg-assistant .prose strong").textContent, "Use stars literally", "assistant text is rendered as Markdown");
  assert.equal($(t.d, "message-input").value, "");
  assert.equal(t.d.querySelectorAll(".conv-item").length, 1);
  assert.equal($(t.d, "chat-title").textContent, "Use *stars* literally");

  const first = t.backend.calls.find((c) => c.url === "/api/chat");
  assert.equal(first.headers["X-CSRFToken"], "test-token");
  assert.equal(first.body.has("conversation_id"), false);

  t.type("follow up"); t.submit();
  await waitFor(() => t.replies() === 2);
  const second = t.backend.calls.filter((c) => c.url === "/api/chat")[1];
  assert.equal(second.body.get("conversation_id"), "c1", "follow-ups continue the same conversation");
  assert.equal(t.d.querySelectorAll(".conv-item").length, 1);
});

test("Enter sends, Shift+Enter does not", async () => {
  const t = await boot();
  t.type("hi");
  const input = $(t.d, "message-input");
  input.dispatchEvent(new t.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(t.backend.calls.filter((c) => c.url === "/api/chat").length, 0);
  input.dispatchEvent(new t.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await waitFor(() => t.replies() === 1);
});

test("over-long messages disable send and show the counter", async () => {
  const t = await boot();
  t.type("x".repeat(4001));
  assert.equal($(t.d, "send-btn").disabled, true);
  assert.equal($(t.d, "char-count").hidden, false);
  assert.ok($(t.d, "char-count").classList.contains("is-over"));
  t.type("short");
  assert.equal($(t.d, "send-btn").disabled, false);
});

test("images: attach, preview, remove, send as multipart and show thumbnails", async () => {
  const t = await boot();
  const { attachments } = t.app.composer;
  attachments.add([png("a.png", 10), png("b.png", 20)]);
  assert.equal(t.d.querySelectorAll("#attachment-list .thumb").length, 2);
  assert.equal($(t.d, "send-btn").disabled, false, "images alone are enough to send");
  t.d.querySelector("#attachment-list .thumb-remove").click();
  assert.equal(attachments.count, 1);

  t.type("what is this?"); t.submit();
  await waitFor(() => t.replies() === 1);
  const sent = t.backend.calls.find((c) => c.url === "/api/chat").body;
  assert.deepEqual(sent.getAll("images").map((f) => f.name), ["b.png"]);
  assert.equal(t.d.querySelectorAll(".msg-user .msg-thumb img").length, 1);
  assert.equal(attachments.count, 0);
  assert.equal($(t.d, "attachment-tray").hidden, true);
});

test("a failed send shows the server's reason; Try again resends; Discard removes", async () => {
  const t = await boot();
  t.backend.failNext(422, "The configured model does not support images.");
  t.type("hello"); t.submit();
  await waitFor(() => t.d.querySelector(".msg-user.is-failed"));
  assert.match(t.d.querySelector(".msg-fail").textContent, /Not sent\. The configured model does not support images\./);
  assert.equal(t.d.querySelectorAll(".conv-item").length, 0, "nothing was saved");

  t.d.querySelector("[data-action=retry]").click();
  await waitFor(() => t.replies() === 1);
  assert.equal(t.d.querySelector(".msg-user.is-failed"), null);
  assert.equal(t.d.querySelectorAll(".msg-user").length, 1, "retry reuses the same bubble");

  t.backend.failNext(500, "boom");
  t.type("second"); t.submit();
  await waitFor(() => t.d.querySelector(".msg-user.is-failed"));
  t.d.querySelector("[data-action=discard]").click();
  assert.equal(t.d.querySelector(".msg-user.is-failed"), null);
});

test("loads history: Markdown, image chips, and clears when starting a new chat", async () => {
  const backend = fakeBackend();
  backend.seed("Old chat", [
    { id: 1, role: "user", content: "look", images: [{ name: "cat.jpg", type: "image/jpeg", size: 2048, width: 800, height: 600 }] },
    { id: 2, role: "assistant", content: "# Cat\n\nA **cat**.", images: [] },
  ]);
  const t = await boot({}, backend);
  t.d.querySelector(".conv-select").click();
  await waitFor(() => t.d.querySelector(".msg-chip"));
  assert.match(t.d.querySelector(".msg-chip").textContent, /cat\.jpg/);
  assert.match(t.d.querySelector(".msg-chip").textContent, /800\u00d7600/);
  assert.equal(t.d.querySelector(".msg-assistant h1").textContent, "Cat");
  assert.equal($(t.d, "chat-title").textContent, "Old chat");
  assert.equal(t.window.localStorage.getItem("chatbot:lastConversation"), "c1");

  $(t.d, "new-chat-btn").click();
  assert.equal(t.d.querySelectorAll(".msg").length, 0);
  assert.equal($(t.d, "thread").classList.contains("has-messages"), false);
  assert.equal($(t.d, "chat-title").textContent, "New chat");
});

test("restores the last conversation on startup and recovers if it was deleted", async () => {
  const backend = fakeBackend();
  const id = backend.seed("Remembered", [{ id: 1, role: "user", content: "q", images: [] }, { id: 2, role: "assistant", content: "a", images: [] }]);
  let page = loadPage(); page.window.localStorage.setItem("chatbot:lastConversation", id);
  initApp({ document: page.document, window: page.window, fetch: backend.fetchFn });
  await waitFor(() => page.document.querySelectorAll(".msg").length === 2, { label: "restored messages" });

  page = loadPage(); page.window.localStorage.setItem("chatbot:lastConversation", "gone");
  initApp({ document: page.document, window: page.window, fetch: backend.fetchFn });
  await waitFor(() => page.document.querySelectorAll(".conv-item").length === 1);
  assert.equal(page.document.querySelectorAll(".msg").length, 0, "falls back to the welcome screen");
});

test("rename and delete (with confirmation) update the sidebar and header", async () => {
  const t = await boot();
  t.type("first chat"); t.submit();
  await waitFor(() => t.replies() === 1);

  t.d.querySelector('.conv-actions button[aria-label^="Rename"]').click();
  const input = t.d.querySelector(".conv-rename");
  input.value = "  Renamed   chat ";
  input.dispatchEvent(new t.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await waitFor(() => t.d.querySelector(".conv-select")?.textContent === "Renamed chat");
  assert.equal($(t.d, "chat-title").textContent, "Renamed chat");

  t.d.querySelector('.conv-actions button[aria-label^="Delete"]').click();
  assert.ok($(t.d, "confirm-dialog").hasAttribute("open"), "confirmation is shown");
  $(t.d, "confirm-cancel").click();
  assert.equal(t.d.querySelectorAll(".conv-item").length, 1);

  t.d.querySelector('.conv-actions button[aria-label^="Delete"]').click();
  $(t.d, "confirm-ok").click();
  await waitFor(() => t.d.querySelectorAll(".conv-item").length === 0);
  assert.equal(t.backend.convs.size, 0);
  assert.equal($(t.d, "chat-title").textContent, "New chat");
  assert.equal(t.d.querySelectorAll(".msg").length, 0);
});

test("welcome starters fill the composer; the image starter opens the file picker", async () => {
  const t = await boot();
  t.d.querySelector('.starter[data-prompt^="Help me write"]').click();
  assert.match($(t.d, "message-input").value, /polite email/);
  let opened = 0;
  $(t.d, "file-input").click = () => { opened += 1; };
  t.d.querySelector('.starter[data-action="attach"]').click();
  assert.equal(opened, 1);
  $(t.d, "attach-btn").click();
  assert.equal(opened, 2);
});

test("voice: mic button toggles listening, inserts editable text, and sending clears it", async () => {
  const t = await boot();
  const mic = $(t.d, "mic-btn");
  mic.click();
  await waitFor(() => mic.getAttribute("aria-pressed") === "true" && !$(t.d, "listening-indicator").hidden);
  assert.match($(t.d, "composer-status").textContent, /Listening/);
  FakeRecognition.last.emit([{ t: "dictated question", final: true }]);
  assert.equal($(t.d, "message-input").value, "dictated question");
  assert.equal($(t.d, "send-btn").disabled, false);
  mic.click();
  await waitFor(() => mic.getAttribute("aria-pressed") === "false");
  assert.equal($(t.d, "message-input").value, "dictated question", "text stays editable, not auto-sent");
  assert.equal(t.backend.calls.filter((c) => c.url === "/api/chat").length, 0);

  mic.click(); await waitFor(() => mic.getAttribute("aria-pressed") === "true");
  t.submit();
  assert.equal(mic.getAttribute("aria-pressed"), "false", "sending ends dictation");
  await waitFor(() => t.replies() === 1);
  assert.equal($(t.d, "message-input").value, "");
});

test("voice errors and unsupported browsers are explained", async () => {
  let t = await boot();
  $(t.d, "mic-btn").click();
  await waitFor(() => FakeRecognition.last?.started);
  FakeRecognition.last.onerror({ error: "not-allowed" });
  assert.match(t.d.querySelector(".toast.is-error").textContent, /Microphone access is blocked/);

  t = await boot({ recognition: false });
  assert.equal($(t.d, "mic-btn").getAttribute("aria-disabled"), "true");
  $(t.d, "mic-btn").click();
  assert.match(t.d.querySelector(".toast.is-error").textContent, /isn't supported in this browser/);
});

test("text-to-speech: speak, global stop control, and per-button toggle", async () => {
  const t = await boot();
  t.type("tell me"); t.submit();
  await waitFor(() => t.replies() === 1);
  const speakBtn = t.d.querySelector("[data-action=speak]");
  assert.equal(speakBtn.getAttribute("aria-label"), "Read aloud");
  speakBtn.click();
  assert.deepEqual(t.synth.spoken, ["Reply to: tell me"], "reads the rendered text, not the Markdown symbols");
  assert.equal(speakBtn.getAttribute("aria-pressed"), "true");
  assert.equal(speakBtn.getAttribute("aria-label"), "Stop reading aloud");
  assert.equal($(t.d, "stop-speaking-btn").hidden, false);

  $(t.d, "stop-speaking-btn").click();
  assert.equal(t.synth.cancelled >= 1, true);
  assert.equal($(t.d, "stop-speaking-btn").hidden, true);
  assert.equal(speakBtn.getAttribute("aria-pressed"), "false");

  speakBtn.click(); speakBtn.click(); // same button again = stop
  assert.equal($(t.d, "stop-speaking-btn").hidden, true);

  speakBtn.click(); t.synth.finish();
  assert.equal($(t.d, "stop-speaking-btn").hidden, true, "hides itself when speech ends");
});

test("sending a new message or starting a new chat stops speech", async () => {
  const t = await boot();
  t.type("one"); t.submit(); await waitFor(() => t.replies() === 1);
  t.d.querySelector("[data-action=speak]").click();
  assert.equal($(t.d, "stop-speaking-btn").hidden, false);
  $(t.d, "new-chat-btn").click();
  assert.equal($(t.d, "stop-speaking-btn").hidden, true);
});

test("mobile drawer opens and closes via button, Escape and scrim", async () => {
  const t = await boot();
  const sidebar = $(t.d, "sidebar");
  $(t.d, "menu-btn").click();
  assert.ok(sidebar.classList.contains("is-open"));
  assert.equal($(t.d, "menu-btn").getAttribute("aria-expanded"), "true");
  t.d.dispatchEvent(new t.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.ok(!sidebar.classList.contains("is-open"));
  $(t.d, "menu-btn").click(); $(t.d, "scrim").click();
  assert.ok(!sidebar.classList.contains("is-open"));
  $(t.d, "menu-btn").click(); $(t.d, "sidebar-close-btn").click();
  assert.ok(!sidebar.classList.contains("is-open"));
});

test("a reply that arrives after switching chats does not appear in the new view", async () => {
  const backend = fakeBackend();
  let release; const gate = new Promise((r) => (release = r));
  const slow = async (url, init) => { if (url === "/api/chat") await gate; return backend.fetchFn(url, init); };
  const page = loadPage();
  const app = initApp({ document: page.document, window: page.window, fetch: slow });
  const d = page.document;
  const input = $(d, "message-input"); input.value = "slow one"; input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  $(d, "composer").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
  $(d, "new-chat-btn").click();
  release();
  await waitFor(() => d.querySelectorAll(".conv-item").length === 1, { label: "sidebar updated" });
  assert.equal(d.querySelectorAll(".msg").length, 0, "new chat view stays clean");
  assert.equal(app.state.busy, false);
});

test("JavaScript failures never lose the page: no libraries still renders replies as text", async () => {
  const t = await boot({ markdown: false });
  t.type("plain"); t.submit();
  await waitFor(() => t.replies() === 1);
  assert.equal(t.d.querySelector(".msg-assistant .prose").textContent, "Reply to: **plain**");
});
