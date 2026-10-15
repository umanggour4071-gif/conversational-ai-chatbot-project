// Conversation list (select / rename / delete) and the mobile slide-over drawer.
import { h, icon } from "./ui.js";

export function createDrawer({ sidebar, scrim, menuBtn, closeBtn }) {
  const doc = sidebar.ownerDocument;

  function isOpen() { return sidebar.classList.contains("is-open"); }
  function open() {
    sidebar.classList.add("is-open");
    scrim.hidden = false;
    menuBtn.setAttribute("aria-expanded", "true");
    closeBtn.focus();
  }
  function close({ restoreFocus = true } = {}) {
    if (!isOpen()) return;
    const hadFocus = sidebar.contains(doc.activeElement);
    sidebar.classList.remove("is-open");
    scrim.hidden = true;
    menuBtn.setAttribute("aria-expanded", "false");
    if (restoreFocus && hadFocus && menuBtn.offsetParent !== null) menuBtn.focus();
  }

  menuBtn.addEventListener("click", () => (isOpen() ? close() : open()));
  closeBtn.addEventListener("click", () => close());
  scrim.addEventListener("click", () => close());
  doc.addEventListener("keydown", (event) => { if (event.key === "Escape" && isOpen()) close(); });
  return { open, close, isOpen };
}

export function createSidebar({ listEl, emptyEl, errorEl, api, confirm, toaster, onSelect, onDeleted, onRenamed = () => {} }) {
  const doc = listEl.ownerDocument;
  let conversations = [];
  let activeId = null;

  function render() {
    listEl.replaceChildren();
    emptyEl.hidden = conversations.length > 0;
    for (const conv of conversations) listEl.append(row(conv));
  }

  function row(conv) {
    const active = conv.id === activeId;
    const select = h(doc, "button", { type: "button", class: "conv-select", title: conv.title, "aria-current": active ? "true" : false, text: conv.title });
    select.addEventListener("click", () => onSelect(conv.id));

    const rename = h(doc, "button", { type: "button", class: "icon-btn", "aria-label": `Rename ${conv.title}`, title: "Rename" }, icon(doc, "pencil"));
    const del = h(doc, "button", { type: "button", class: "icon-btn danger", "aria-label": `Delete ${conv.title}`, title: "Delete" }, icon(doc, "trash"));
    const li = h(doc, "li", { class: `conv-item${active ? " is-active" : ""}`, "data-id": conv.id }, select, h(doc, "div", { class: "conv-actions" }, rename, del));

    rename.addEventListener("click", () => startRename(li, conv, select));
    del.addEventListener("click", async () => {
      const ok = await confirm({ heading: "Delete conversation?", message: `\u201c${conv.title}\u201d and its messages will be removed. This can't be undone.`, confirmLabel: "Delete" });
      if (!ok) { del.focus(); return; }
      try {
        await api.deleteConversation(conv.id);
        conversations = conversations.filter((c) => c.id !== conv.id);
        render();
        toaster.success("Conversation deleted.");
        onDeleted(conv.id);
      } catch (err) { toaster.error(err.message); del.focus(); }
    });
    return li;
  }

  function startRename(li, conv, select) {
    const input = h(doc, "input", { class: "conv-rename", type: "text", maxlength: 100, "aria-label": "Conversation title", value: conv.title });
    li.querySelector(".conv-actions").hidden = true;
    select.replaceWith(input);
    input.focus(); input.select();
    let finished = false;

    async function finish(save) {
      if (finished) return;
      finished = true;
      const title = input.value.split(/\s+/).filter(Boolean).join(" ");
      if (!save || !title || title === conv.title) { render(); return; }
      try {
        const res = await api.renameConversation(conv.id, title);
        conv.title = res.title;
        render();
        onRenamed(conv.id, res.title);
      } catch (err) { toaster.error(err.message); render(); }
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  async function refresh() {
    errorEl.hidden = true;
    if (!conversations.length) {
      listEl.replaceChildren(...[0, 1, 2].map(() => h(doc, "li", { class: "conv-skeleton", "aria-hidden": "true" })));
      emptyEl.hidden = true;
    }
    try {
      conversations = await api.listConversations();
    } catch (err) {
      errorEl.textContent = `Couldn't load conversations. ${err.message}`;
      errorEl.hidden = false;
    }
    render();
    return conversations;
  }

  return {
    refresh,
    setActive(id) { activeId = id; render(); },
    has: (id) => conversations.some((c) => c.id === id),
    titleOf: (id) => conversations.find((c) => c.id === id)?.title,
    /** Insert or update a conversation and move it to the top (it was just used). */
    touch(id, title) {
      conversations = [{ id, title }, ...conversations.filter((c) => c.id !== id)];
      render();
    },
  };
}
