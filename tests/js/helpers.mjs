// Shared test helpers: load the REAL templates/index.html into jsdom, with fake browser APIs.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { marked } from "marked";

const TEMPLATE = new URL("../../templates/index.html", import.meta.url);

export function renderTemplate() {
  return readFileSync(TEMPLATE, "utf8")
    .replace(/{{\s*csrf_token\s*}}/g, "test-token")
    .replace(/{{\s*limits\.max_images\s*}}/g, "4")
    .replace(/{{\s*limits\.max_image_mb\s*}}/g, "5")
    .replace(/{{\s*limits\.max_chars\s*}}/g, "4000");
}

export class FakeRecognition {
  static last = null;
  constructor() { FakeRecognition.last = this; this.started = false; }
  start() { this.started = true; queueMicrotask(() => this.onstart?.()); }
  stop() { queueMicrotask(() => this.onend?.()); }
  abort() { this.aborted = true; this.onend?.(); }
  emit(parts, resultIndex = 0) {
    const results = parts.map((p) => Object.assign([{ transcript: p.t }], { isFinal: p.final }));
    this.onresult({ resultIndex, results });
  }
}

export function makeSynth() {
  const synth = {
    speaking: false, pending: false, paused: false, spoken: [], cancelled: 0, current: null,
    getVoices: () => [],
    speak(u) { synth.speaking = true; synth.current = u; synth.spoken.push(u.text); },
    cancel() { synth.speaking = false; synth.current = null; synth.cancelled += 1; },
    resume() {},
    finish() { const u = synth.current; synth.speaking = false; synth.current = null; u?.onend?.({}); },
  };
  return synth;
}

export function loadPage({ recognition = true, synth = true, markdown = true } = {}) {
  const dom = new JSDOM(renderTemplate(), { url: "http://localhost/", pretendToBeVisual: true });
  const { window } = dom;
  window.URL.createObjectURL = () => "blob:test";
  window.URL.revokeObjectURL = () => {};
  if (markdown) { window.marked = marked; window.DOMPurify = createDOMPurify(window); }
  const fakeSynth = makeSynth();
  if (synth) {
    Object.defineProperty(window, "speechSynthesis", { value: fakeSynth, configurable: true });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  }
  if (recognition) window.SpeechRecognition = FakeRecognition;
  FakeRecognition.last = null;
  return { dom, window, document: window.document, synth: fakeSynth };
}

export const $ = (doc, id) => doc.getElementById(id);

export async function waitFor(predicate, { timeout = 2000, label = "condition" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export const png = (name = "a.png", size = 100) => new File([new Uint8Array(size)], name, { type: "image/png", lastModified: size });
