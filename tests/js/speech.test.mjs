import test from "node:test";
import assert from "node:assert/strict";
import { chunkText, pickVoice, createSpeaker } from "../../static/js/speech.js";
import { makeSynth } from "./helpers.mjs";

class U { constructor(text) { this.text = text; } }

test("chunkText splits on sentences and keeps chunks short", () => {
  const chunks = chunkText("One. Two! Three? " + "word ".repeat(80));
  assert.deepEqual(chunks.slice(0, 3), ["One.", "Two!", "Three?"]);
  assert.ok(chunks.every((c) => c.length <= 181), "chunk too long");
  assert.ok(chunkText("   ").length === 0);
});

test("pickVoice prefers an exact language match, then the base language", () => {
  const voices = [{ lang: "fr-FR" }, { lang: "en-GB" }, { lang: "en-US" }];
  assert.equal(pickVoice(voices, "en-US").lang, "en-US");
  assert.equal(pickVoice(voices, "en-AU").lang, "en-GB");
  assert.equal(pickVoice(voices, "de-DE"), undefined);
});

test("speaks chunks one at a time and reports state changes", () => {
  const synth = makeSynth(); const states = [];
  const speaker = createSpeaker({ synth, Utterance: U, onChange: (s) => states.push({ ...s }) });
  assert.ok(speaker.speak("First sentence. Second sentence.", { id: "a" }));
  assert.deepEqual(synth.spoken, ["First sentence."]);
  assert.equal(speaker.activeId, "a");
  synth.finish();
  assert.deepEqual(synth.spoken, ["First sentence.", "Second sentence."]);
  synth.finish();
  assert.equal(speaker.activeId, null);
  assert.deepEqual(states.map((s) => s.speaking), [true, false]);
});

test("stop cancels playback and ignores late callbacks", () => {
  const synth = makeSynth();
  const speaker = createSpeaker({ synth, Utterance: U });
  speaker.speak("One. Two. Three.", { id: "a" });
  const pending = synth.current;
  speaker.stop();
  assert.equal(synth.cancelled, 1);
  assert.equal(speaker.activeId, null);
  pending.onend({}); // a late end event must not start the next chunk
  assert.equal(synth.spoken.length, 1);
});

test("starting a new message stops the previous one", () => {
  const synth = makeSynth();
  const speaker = createSpeaker({ synth, Utterance: U });
  speaker.speak("Hello there.", { id: "a" });
  speaker.speak("Another one.", { id: "b" });
  assert.equal(speaker.activeId, "b");
  assert.equal(synth.cancelled, 1);
});

test("engine errors are reported, cancellations are not", () => {
  const synth = makeSynth(); const errors = [];
  const speaker = createSpeaker({ synth, Utterance: U, onError: (m) => errors.push(m) });
  speaker.speak("Hello.", { id: "a" });
  synth.current.onerror({ error: "synthesis-failed" });
  assert.equal(errors.length, 1);
  assert.equal(speaker.activeId, null);
  speaker.speak("Again.", { id: "a" });
  synth.current.onerror({ error: "interrupted" });
  assert.equal(errors.length, 1);
});

test("unsupported browsers report instead of throwing", () => {
  const errors = [];
  const speaker = createSpeaker({ synth: undefined, Utterance: undefined, onError: (m) => errors.push(m) });
  assert.equal(speaker.supported, false);
  assert.equal(speaker.speak("Hi."), false);
  assert.match(errors[0], /isn't supported/);
  assert.doesNotThrow(() => speaker.stop());
});
