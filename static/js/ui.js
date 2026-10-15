// Small DOM helpers shared by every module: element builder, icons, toasts, dialogs, formatting.

const SVG_NS = "http://www.w3.org/2000/svg";

/** Create an element: h(doc, "button", { class: "x", "aria-label": "Y" }, child, "text", ...). */
export function h(doc, tag, attrs = {}, ...children) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value == null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

/** An <svg><use href="#i-name"/></svg> reference into the sprite defined in index.html. */
export function icon(doc, name, extraClass = "") {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", ("icon " + extraClass).trim());
  svg.setAttribute("aria-hidden", "true");
  const use = doc.createElementNS(SVG_NS, "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

/** Swap which sprite symbol an existing icon element points at. */
export function setIcon(svg, name) {
  const use = svg.querySelector("use");
  if (use) use.setAttribute("href", "#i-" + name);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Grow a textarea to fit its content (up to its CSS max-height). */
export function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = textarea.scrollHeight ? `${textarea.scrollHeight}px` : "";
}

/** Toast notifications. Errors linger longer; at most four are visible at once. */
export function createToaster(container) {
  const doc = container.ownerDocument;
  const MAX = 4;

  function show(message, { type = "info", timeout } = {}) {
    while (container.children.length >= MAX) container.firstElementChild.remove();
    const closeBtn = h(doc, "button", { type: "button", class: "icon-btn", "aria-label": "Dismiss notification" }, icon(doc, "x"));
    const toast = h(doc, "div", { class: `toast is-${type}`, role: type === "error" ? "alert" : "status" },
      h(doc, "span", { class: "toast-text", text: message }), closeBtn);
    const dismiss = () => toast.remove();
    closeBtn.addEventListener("click", dismiss);
    container.append(toast);
    const ms = timeout ?? (type === "error" ? 9000 : 4500);
    if (ms > 0) setTimeout(dismiss, ms);
    return dismiss;
  }
  return { show, error: (m) => show(m, { type: "error" }), success: (m) => show(m, { type: "success", timeout: 2500 }) };
}

/** Promise-based confirm dialog on top of <dialog>; degrades to the `open` attribute if needed. */
export function createConfirm(dialog) {
  const doc = dialog.ownerDocument;
  const title = doc.getElementById("confirm-title");
  const text = doc.getElementById("confirm-text");
  const okBtn = doc.getElementById("confirm-ok");
  const cancelBtn = doc.getElementById("confirm-cancel");
  let settle = null;

  function close(result) {
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
    const done = settle;
    settle = null;
    if (done) done(result);
  }

  okBtn.addEventListener("click", () => close(true));
  cancelBtn.addEventListener("click", () => close(false));
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(false); }); // Esc key
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(false); }); // backdrop

  return function confirm({ heading, message, confirmLabel = "Delete" }) {
    if (settle) close(false);
    title.textContent = heading;
    text.textContent = message;
    okBtn.textContent = confirmLabel;
    return new Promise((resolve) => {
      settle = resolve;
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      cancelBtn.focus();
    });
  };
}
