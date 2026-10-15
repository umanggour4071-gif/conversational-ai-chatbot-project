// Pending image attachments: validation, preview thumbnails and removal.
// The server re-validates every image by decoding it; these checks give instant feedback.
import { h, icon, formatBytes } from "./ui.js";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_EXT = /\.(jpe?g|png|webp)$/i;

export function isAllowedType(file) {
  if (file.type) return ALLOWED_TYPES.has(file.type);
  return ALLOWED_EXT.test(file.name || "");
}

export function createAttachments({ trayEl, listEl, maxImages, maxBytes, urlApi = URL, onChange = () => {}, onError = () => {} }) {
  const doc = listEl.ownerDocument;
  let items = []; // { id, file, url, node }
  let seq = 0;

  const maxMb = Math.round(maxBytes / (1024 * 1024));

  function validate(file, pendingCount) {
    if (!isAllowedType(file)) return `${file.name || "That file"} isn't a supported image. Use JPEG, PNG or WebP.`;
    if (file.size === 0) return `${file.name} is empty.`;
    if (file.size > maxBytes) return `${file.name} is ${formatBytes(file.size)}. The limit is ${maxMb} MB per image.`;
    if (pendingCount >= maxImages) return `You can attach up to ${maxImages} image${maxImages === 1 ? "" : "s"} per message.`;
    return null;
  }

  function remove(id) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    item.node.remove();
    urlApi.revokeObjectURL(item.url);
    items = items.filter((i) => i.id !== id);
    sync();
  }

  function sync() {
    trayEl.hidden = items.length === 0;
    onChange(items.map((i) => i.file));
  }

  function add(fileList) {
    const errors = [];
    let capacityWarned = false;
    for (const file of Array.from(fileList || [])) {
      if (items.some((i) => i.file.name === file.name && i.file.size === file.size && i.file.lastModified === file.lastModified)) continue;
      const problem = validate(file, items.length);
      if (problem) {
        if (problem.startsWith("You can attach")) { if (capacityWarned) continue; capacityWarned = true; }
        errors.push(problem);
        continue;
      }
      const id = ++seq;
      const url = urlApi.createObjectURL(file);
      const img = h(doc, "img", { src: url, alt: `Preview of ${file.name}` });
      img.addEventListener("error", () => {
        remove(id);
        onError(`${file.name} can't be read as an image. It may be damaged.`);
      });
      const removeBtn = h(doc, "button", { type: "button", class: "thumb-remove", "aria-label": `Remove ${file.name}` }, icon(doc, "x"));
      removeBtn.addEventListener("click", () => remove(id));
      const node = h(doc, "li", { class: "thumb", title: file.name }, img, h(doc, "span", { class: "thumb-size", text: formatBytes(file.size) }), removeBtn);
      listEl.append(node);
      items.push({ id, file, url, node });
    }
    sync();
    errors.forEach(onError);
    return { added: items.length, errors };
  }

  function clear() {
    items.forEach((i) => { i.node.remove(); urlApi.revokeObjectURL(i.url); });
    items = [];
    sync();
  }

  return { add, remove, clear, files: () => items.map((i) => i.file), get count() { return items.length; }, get limit() { return maxImages; } };
}
