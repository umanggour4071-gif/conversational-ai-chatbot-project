// Text-to-speech on top of the browser's speechSynthesis. Long replies are spoken in sentence-sized
// chunks, one utterance at a time, because several engines silently cut off long utterances.

export function chunkText(text, max = 180) {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
  const chunks = [];
  for (let sentence of sentences) {
    while (sentence.length > max) {
      let cut = sentence.lastIndexOf(", ", max);
      if (cut < max / 2) cut = sentence.lastIndexOf(" ", max);
      if (cut <= 0) cut = max;
      chunks.push(sentence.slice(0, cut + 1).trim());
      sentence = sentence.slice(cut + 1).trim();
    }
    if (sentence) chunks.push(sentence);
  }
  return chunks;
}

export function pickVoice(voices, lang) {
  if (!voices || !voices.length || !lang) return undefined;
  const wanted = lang.toLowerCase();
  const base = wanted.split("-")[0];
  return voices.find((v) => v.lang.toLowerCase() === wanted && v.default) ||
    voices.find((v) => v.lang.toLowerCase() === wanted) ||
    voices.find((v) => v.lang.toLowerCase().split(/[-_]/)[0] === base);
}

export function createSpeaker({ synth, Utterance, lang = "en-US", onChange = () => {}, onError = () => {} }) {
  const supported = Boolean(synth && Utterance);
  let activeId = null;
  let generation = 0;

  function emit() { onChange({ speaking: activeId !== null, id: activeId }); }

  function stop() {
    generation += 1; // invalidates callbacks from any utterance still in flight
    if (supported && (synth.speaking || synth.pending || synth.paused)) synth.cancel();
    if (activeId !== null) { activeId = null; emit(); }
  }

  function speak(text, { id = "default" } = {}) {
    if (!supported) { onError("Read aloud isn't supported in this browser."); return false; }
    const chunks = chunkText(text);
    if (!chunks.length) return false;
    stop();
    const mine = generation;
    activeId = id;
    emit();
    if (synth.paused) synth.resume();
    const voice = pickVoice(synth.getVoices ? synth.getVoices() : [], lang);

    const next = (index) => {
      if (mine !== generation) return;
      if (index >= chunks.length) { activeId = null; emit(); return; }
      const utterance = new Utterance(chunks[index]);
      utterance.lang = voice ? voice.lang : lang;
      if (voice) utterance.voice = voice;
      utterance.onend = () => next(index + 1);
      utterance.onerror = (event) => {
        if (mine !== generation) return;
        const reason = event && event.error;
        activeId = null;
        emit();
        if (reason && reason !== "canceled" && reason !== "interrupted") onError("Couldn't read this aloud. Your browser reported: " + reason + ".");
      };
      synth.speak(utterance);
    };
    next(0);
    return true;
  }

  return { supported, speak, stop, get activeId() { return activeId; } };
}
