// Markdown -> sanitized DOM. marked parses, DOMPurify sanitizes, then we add code-block chrome.
// If either library failed to load we fall back to plain text, so a reply is never lost.
import { h, icon } from "./ui.js";

const SAFE_URI = /^(?:https?:|mailto:)/i;

export function createMarkdownRenderer({ marked, purify, doc }) {
  const available = Boolean(marked && purify && typeof marked.parse === "function");

  if (available) {
    purify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A" && node.hasAttribute("href")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow");
      }
    });
  }

  function enhance(fragment) {
    fragment.querySelectorAll("pre").forEach((pre) => {
      const code = pre.querySelector("code");
      const match = code && /language-([\w+#.-]+)/.exec(code.className || "");
      const copy = h(doc, "button", { type: "button", class: "link-btn codeblock-copy", "aria-label": "Copy code" },
        icon(doc, "copy"), h(doc, "span", { text: "Copy" }));
      const wrapper = h(doc, "div", { class: "codeblock" },
        h(doc, "div", { class: "codeblock-bar" }, h(doc, "span", { text: match ? match[1] : "code" }), copy));
      pre.replaceWith(wrapper);
      wrapper.append(pre);
    });
    fragment.querySelectorAll("table").forEach((table) => {
      const wrap = h(doc, "div", { class: "table-wrap" });
      table.replaceWith(wrap);
      wrap.append(table);
    });
  }

  /** Replace the contents of `target` with the rendered Markdown of `text`. */
  function render(target, text) {
    target.replaceChildren();
    if (!available) {
      target.textContent = text;
      target.style.whiteSpace = "pre-wrap";
      return target;
    }
    let html;
    try {
      html = marked.parse(text, { gfm: true, breaks: false, async: false });
    } catch {
      target.textContent = text;
      return target;
    }
    const fragment = purify.sanitize(html, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_URI_REGEXP: SAFE_URI,
      FORBID_TAGS: ["img", "picture", "svg", "math", "style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed"],
      FORBID_ATTR: ["style", "srcset"],
    });
    enhance(fragment);
    target.append(fragment);
    return target;
  }

  return { render, available };
}

const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, blockquote, tr, pre";

/** The text a screen reader / speech synthesiser should read for a rendered message (code is skipped). */
export function speakableText(proseEl) {
  const clone = proseEl.cloneNode(true);
  clone.querySelectorAll(".codeblock").forEach((block) => block.replaceWith(clone.ownerDocument.createTextNode(" Code block omitted. ")));
  clone.querySelectorAll("button").forEach((b) => b.remove());
  clone.querySelectorAll(BLOCKS).forEach((block) => {
    const trimmed = block.textContent.trim();
    const needsStop = trimmed && !/[.!?:;…]$/.test(trimmed) && /^(LI|H[1-6]|TR)$/.test(block.tagName);
    block.append(clone.ownerDocument.createTextNode(needsStop ? ". " : " "));
  });
  return clone.textContent.replace(/\s+/g, " ").trim();
}
