import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createVoiceInput, describeVoiceError, UNSUPPORTED_MESSAGE } from "../../static/js/voice.js";
import { FakeRecognition } from "./helpers.mjs";

function setup(extra = {}) {
  const { window } = new JSDOM("<textarea></textarea>");
  const textarea = window.document.querySelector("textarea");
  const states = [], errors = [];
  const voice = createVoiceInput({ SpeechRecognition: FakeRecognition, textarea, lang: "en-US",
    onState: (s) => states.push(s), onError: (e) => errors.push(e), ...extra });
  return { textarea, voice, states, errors };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("starts, listens and returns to idle", async () => {
  const { voice, states } = setup();
  assert.ok(voice.start());
  assert.equal(voice.state, "starting");
  await tick();
  assert.equal(voice.state, "listening");
  voice.stop();
  await tick();
  assert.equal(voice.state, "idle");
  assert.deepEqual(states, ["starting", "listening", "idle"]);
});

test("inserts interim then final text into the box, keeping existing text", async () => {
  const { voice, textarea } = setup();
  textarea.value = "Hello";
  textarea.setSelectionRange(5, 5);
  voice.start(); await tick();
  FakeRecognition.last.emit([{ t: "how is", final: false }]);
  assert.equal(textarea.value, "Hello how is");
  FakeRecognition.last.emit([{ t: "how is it", final: true }]);
  FakeRecognition.last.emit([{ t: "how is it", final: true }, { t: " going", final: false }], 1);
  assert.equal(textarea.value, "Hello how is it going");
  voice.stop(); await tick();
  assert.equal(textarea.value, "Hello how is it going", "trailing interim words are kept when dictation ends");
});

test("inserts at the caret and preserves the text after it", async () => {
  const { voice, textarea } = setup();
  textarea.value = "Start End";
  textarea.setSelectionRange(5, 5);
  voice.start(); await tick();
  FakeRecognition.last.emit([{ t: "middle", final: true }]);
  assert.equal(textarea.value, "Start middle End");
});

test("typing while listening stops dictation", async () => {
  const { voice, textarea } = setup();
  voice.start(); await tick();
  textarea.dispatchEvent(new textarea.ownerDocument.defaultView.Event("input", { bubbles: true }));
  await tick();
  assert.equal(voice.state, "idle");
});

test("abort drops pending results and never re-fills the box", async () => {
  const { voice, textarea } = setup();
  voice.start(); await tick();
  FakeRecognition.last.emit([{ t: "spoken", final: false }]);
  textarea.value = ""; // the message was sent and the box cleared
  voice.abort();
  await tick();
  assert.equal(textarea.value, "");
  assert.equal(voice.state, "idle");
});

test("maps recognition errors to helpful messages", async () => {
  const { voice, errors } = setup();
  voice.start(); await tick();
  FakeRecognition.last.onerror({ error: "not-allowed" });
  FakeRecognition.last.onerror({ error: "aborted" }); // silent
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Microphone access is blocked/);
  assert.match(describeVoiceError("no-speech"), /No speech detected/);
  assert.match(describeVoiceError("audio-capture"), /No microphone/);
  assert.match(describeVoiceError("network"), /internet/);
  assert.match(describeVoiceError("weird"), /weird/);
});

test("unsupported browsers get a clear error and never start", () => {
  const { voice, errors } = setup({ SpeechRecognition: undefined });
  assert.equal(voice.supported, false);
  assert.equal(voice.start(), false);
  assert.equal(errors[0].message, UNSUPPORTED_MESSAGE);
});

test("a failing start() is reported and leaves the input idle", () => {
  class Broken extends FakeRecognition { start() { throw new Error("already started"); } }
  const { voice, errors } = setup({ SpeechRecognition: Broken });
  assert.equal(voice.start(), false);
  assert.equal(voice.state, "idle");
  assert.equal(errors[0].code, "start-failed");
});

test("toggle starts and stops", async () => {
  const { voice } = setup();
  voice.toggle(); await tick();
  assert.ok(voice.listening);
  voice.toggle(); await tick();
  assert.ok(!voice.listening);
});
