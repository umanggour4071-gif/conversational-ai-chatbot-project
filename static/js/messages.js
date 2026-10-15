// Renders the conversation thread: user messages (with image thumbnails or chips), assistant
// messages (Markdown, copy, read aloud), the thinking indicator and failed-send state.
import { h, icon, setIcon, formatBytes } from "./ui.js";
import { speakableText } from "./markdown.js";

export function createMessageView({ listEl, threadEl, markdown, speaker, urlApi = URL, toaster, onRetry, onDiscard }) {
  const doc = listEl.ownerDocument;
  let objectUrls = [];
  let speakSeq = 0;
  const rawText = new WeakMap(); // assistant <li> -> original Markdown, used by "Copy response"

  const nearBottom = () => threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 120;
  function scrollToBottom() { threadEl.scrollTop = threadEl.scrollHeight; }
  function scrollToStartOf(el) {
    if (el.offsetHeight > threadEl.clientHeight * 0.8) {
      threadEl.scrollTop += el.getBoundingClientRect().top - threadEl.getBoundingClientRect().top - 16;
    } else scrollToBottom();
  }
  function append(li) { listEl.append(li); threadEl.classList.add("has-messages"); return li; }

  // ---- user messages ------------------------------------------------------
  function imagesBlock({ files, meta }) {
    const items = [];
    for (const file of files || []) {
      const url = urlApi.createObjectURL(file);
      objectUrls.push(url);
      items.push(h(doc, "li", { class: "msg-thumb" }, h(doc, "img", { src: url, alt: `Attached image ${file.name}` })));
    }
    for (const m of meta || []) {
      const dims = m.width && m.height ? `${m.width}\u00d7${m.height}` : "";
      const detail = [dims, formatBytes(m.size)].filter(Boolean).join(", ");
      items.push(h(doc, "li", { class: "msg-chip", title: m.name },
        icon(doc, "image"), h(doc, "span", { class: "msg-chip-name", text: m.name }), detail && h(doc, "span", { text: detail })));
    }
    return items.length ? h(doc, "ul", { class: "msg-images", "aria-label": "Attached images" }, items) : null;
  }

  function addUser({ text = "", files = [], meta = [], status = "sent" }) {
    const body = h(doc, "div", { class: "msg-body" },
      imagesBlock({ files, meta }),
      text && h(doc, "p", { class: "msg-text", text }));
    if (!text && !body.querySelector(".msg-images")) body.append(h(doc, "p", { class: "msg-text", text: "(image)" }));
    const wrap = h(doc, "div", { class: "msg-user-wrap" }, h(doc, "span", { class: "sr-only", text: "You said:" }), body);
    const li = append(h(doc, "li", { class: `msg msg-user${status === "sending" ? " is-sending" : ""}` }, wrap));
    scrollToBottom();

    const handle = {
      el: li,
      markSent() { li.classList.remove("is-sending", "is-failed"); wrap.querySelector(".msg-fail")?.remove(); },
      markSending() { li.classList.add("is-sending"); li.classList.remove("is-failed"); wrap.querySelector(".msg-fail")?.remove(); },
      markFailed(message) {
        li.classList.remove("is-sending");
        li.classList.add("is-failed");
        wrap.querySelector(".msg-fail")?.remove();
        const retry = h(doc, "button", { type: "button", class: "link-btn", "data-action": "retry" }, icon(doc, "retry"), h(doc, "span", { text: "Try again" }));
        const discard = h(doc, "button", { type: "button", class: "link-btn", "data-action": "discard" }, icon(doc, "x"), h(doc, "span", { text: "Discard" }));
        retry.addEventListener("click", () => onRetry(handle));
        discard.addEventListener("click", () => { li.remove(); if (!listEl.children.length) threadEl.classList.remove("has-messages"); onDiscard(handle); });
        wrap.append(h(doc, "div", { class: "msg-fail", role: "alert" }, h(doc, "span", { text: `Not sent. ${message}` }), retry, discard));
        scrollToBottom();
      },
    };
    return handle;
  }

  // ---- assistant messages -------------------------------------------------
  function actionButton(label, iconName, extra = {}) {
    return h(doc, "button", { type: "button", class: "icon-btn", "aria-label": label, title: label, ...extra }, icon(doc, iconName));
  }

  function addAssistant({ content }) {
    const prose = h(doc, "div", { class: "prose" });
    markdown.render(prose, content);
    const key = `m${++speakSeq}`;
    const copyBtn = actionButton("Copy response", "copy", { "data-action": "copy" });
    const speakBtn = actionButton("Read aloud", "speaker", { "data-action": "speak", "data-key": key, "aria-pressed": "false" });
    if (!speaker.supported) {
      const note = "Read aloud isn't supported in this browser";
      speakBtn.setAttribute("aria-disabled", "true");
      speakBtn.setAttribute("aria-label", note);
      speakBtn.title = note;
    }
    const li = append(h(doc, "li", { class: "msg msg-assistant" },
      avatar(),
      h(doc, "div", { class: "msg-main" },
        h(doc, "span", { class: "sr-only", text: "Assistant said:" }), prose,
        h(doc, "div", { class: "msg-actions" }, copyBtn, speakBtn))));
    rawText.set(li, content);
    scrollToStartOf(li);
    return li;
  }

  function avatar() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("class", "avatar"); svg.setAttribute("viewBox", "0 0 32 32"); svg.setAttribute("aria-hidden", "true");
    const rect = doc.createElementNS(NS, "rect");
    for (const [k, v] of Object.entries({ x: 1, y: 1, width: 30, height: 30, rx: 9 })) rect.setAttribute(k, v);
    const path = doc.createElementNS(NS, "path");
    path.setAttribute("d", "M9 14v4M13.5 10v12M18.5 7.5v17M23 12v8");
    svg.append(rect, path);
    return svg;
  }

  function addThinking() {
    const li = append(h(doc, "li", { class: "msg msg-assistant", role: "status", "aria-label": "The assistant is thinking" },
      avatar(), h(doc, "div", { class: "msg-main" }, h(doc, "span", { class: "thinking", "aria-hidden": "true" }, h(doc, "i"), h(doc, "i"), h(doc, "i"), h(doc, "i")))));
    scrollToBottom();
    return { remove() { li.remove(); } };
  }

  // ---- delegated actions --------------------------------------------------
  async function copyText(text) {
    try {
      if (doc.defaultView.navigator.clipboard?.writeText) { await doc.defaultView.navigator.clipboard.writeText(text); return true; }
    } catch { /* fall through to legacy path */ }
    try {
      const area = h(doc, "textarea", { class: "sr-only", "aria-hidden": "true" });
      area.value = text; doc.body.append(area); area.select();
      const ok = doc.execCommand && doc.execCommand("copy");
      area.remove();
      return Boolean(ok);
    } catch { return false; }
  }

  function flashDone(btn, label) {
    const svg = btn.querySelector("svg"); const labelSpan = btn.querySelector("span");
    setIcon(svg, "check"); btn.classList.add("is-done");
    if (labelSpan) labelSpan.textContent = "Copied";
    setTimeout(() => { setIcon(svg, "copy"); btn.classList.remove("is-done"); if (labelSpan) labelSpan.textContent = label; }, 1600);
  }

  listEl.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || !listEl.contains(button)) return;

    if (button.classList.contains("codeblock-copy")) {
      const code = button.closest(".codeblock").querySelector("pre").textContent;
      if (await copyText(code)) flashDone(button, "Copy"); else toaster.error("Couldn't copy to the clipboard.");
      return;
    }
    const action = button.dataset.action;
    const msg = button.closest(".msg-assistant");
    if (action === "copy" && msg) {
      const text = rawText.get(msg) ?? msg.querySelector(".prose").textContent;
      if (await copyText(text)) flashDone(button, ""); else toaster.error("Couldn't copy to the clipboard.");
    } else if (action === "speak" && msg) {
      if (!speaker.supported) { toaster.error("Read aloud isn't supported in this browser."); return; }
      if (speaker.activeId === button.dataset.key) speaker.stop();
      else speaker.speak(speakableText(msg.querySelector(".prose")), { id: button.dataset.key });
    }
  });

  /** Reflect speaker state on every speak button (called from the speaker's onChange). */
  function syncSpeaking({ speaking, id }) {
    listEl.querySelectorAll('button[data-action="speak"]').forEach((btn) => {
      const active = speaking && btn.dataset.key === id;
      btn.setAttribute("aria-pressed", String(active));
      const label = active ? "Stop reading aloud" : "Read aloud";
      if (speaker.supported) { btn.setAttribute("aria-label", label); btn.title = label; }
      setIcon(btn.querySelector("svg"), active ? "stop" : "speaker");
    });
  }

  function clear() {
    listEl.replaceChildren();
    threadEl.classList.remove("has-messages");
    objectUrls.forEach((u) => urlApi.revokeObjectURL(u));
    objectUrls = [];
    threadEl.scrollTop = 0;
  }

  return { addUser, addAssistant, addThinking, clear, syncSpeaking, scrollToBottom, nearBottom };
}
