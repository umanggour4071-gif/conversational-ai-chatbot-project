import test from "node:test";
import assert from "node:assert/strict";
import { loadPage } from "./helpers.mjs";
import { createMarkdownRenderer, speakableText } from "../../static/js/markdown.js";

function setup(opts) {
  const page = loadPage(opts);
  const md = createMarkdownRenderer({ marked: page.window.marked, purify: page.window.DOMPurify, doc: page.document });
  const target = page.document.createElement("div");
  return { ...page, md, target };
}

test("renders headings, emphasis, lists and inline code", () => {
  const { md, target } = setup();
  md.render(target, "## Title\n\nSome **bold** and `code`.\n\n- one\n- two");
  assert.equal(target.querySelector("h2").textContent, "Title");
  assert.equal(target.querySelector("strong").textContent, "bold");
  assert.equal(target.querySelectorAll("li").length, 2);
  assert.equal(target.querySelector("p code").textContent, "code");
});

test("wraps code blocks with a language label and copy button", () => {
  const { md, target } = setup();
  md.render(target, "```js\nconst x = 1;\n```");
  assert.equal(target.querySelector(".codeblock-bar span").textContent, "js");
  assert.ok(target.querySelector(".codeblock-copy"));
  assert.equal(target.querySelector(".codeblock pre code").textContent.trim(), "const x = 1;");
});

test("wraps tables for horizontal scrolling", () => {
  const { md, target } = setup();
  md.render(target, "| a | b |\n|---|---|\n| 1 | 2 |");
  assert.ok(target.querySelector(".table-wrap > table"));
});

test("links open in a new tab safely", () => {
  const { md, target } = setup();
  md.render(target, "[site](https://example.com)");
  const a = target.querySelector("a");
  assert.equal(a.target, "_blank");
  assert.match(a.rel, /noopener/);
});

test("sanitizes scripts, event handlers, javascript: links and remote images", () => {
  const { md, target } = setup();
  md.render(target, [
    "<script>window.hacked = 1</script>",
    '<img src="https://evil.test/x.png" onerror="window.hacked=1">',
    "[bad](javascript:alert(1))",
    "![pic](https://evil.test/track.png)",
    '<a href="https://ok.test" onclick="window.hacked=1">ok</a>',
    '<div style="position:fixed">x</div>',
    "<iframe src=\"https://evil.test\"></iframe>",
  ].join("\n\n"));
  assert.equal(target.querySelector("script"), null);
  assert.equal(target.querySelector("img"), null);
  assert.equal(target.querySelector("iframe"), null);
  assert.equal(target.querySelector("[onclick], [onerror]"), null);
  assert.equal(target.querySelector("[style]"), null);
  for (const a of target.querySelectorAll("a")) assert.doesNotMatch(a.getAttribute("href") || "", /^javascript:/i);
});

test("falls back to plain text when the libraries are missing", () => {
  const { md, target } = setup({ markdown: false });
  assert.equal(md.available, false);
  md.render(target, "**not parsed** <b>x</b>");
  assert.equal(target.textContent, "**not parsed** <b>x</b>");
  assert.equal(target.querySelector("b"), null);
});

test("speakableText skips code, drops buttons and separates list items", () => {
  const { md, target } = setup();
  md.render(target, "# Heading\n\n- first\n- second\n\n```py\nsecret_code()\n```\n\nDone.");
  const text = speakableText(target);
  assert.doesNotMatch(text, /secret_code/);
  assert.match(text, /Code block omitted/);
  assert.doesNotMatch(text, /Copy/);
  assert.match(text, /Heading\. first\. second\./);
});
