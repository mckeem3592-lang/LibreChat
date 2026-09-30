import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersistentMacSpeech } from './persistentMacSpeech.ts';

function fixture() {
  const sessions = [];
  const timers = new Map();
  let nextTimer = 1;
  const texts = [];
  const stopped = [];
  const track = { readyState: 'live' };
  const speech = createPersistentMacSpeech({
    track,
    language: 'en-US',
    createRecognition: () => {
      const session = { start: () => {}, stop: () => {}, onresult: null, onerror: null, onend: null };
      sessions.push(session);
      return session;
    },
    onTranscript: (text) => texts.push(text),
    onStopped: (error) => stopped.push(error),
    schedule: (callback) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    cancel: (id) => timers.delete(id),
  });
  const tick = () => {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach((callback) => callback());
  };
  return { speech, sessions, timers, texts, stopped, track, tick };
}

test('continuous Mac dictation keeps earlier words and restarts after a pause', () => {
  const f = fixture();
  f.speech.start();
  f.sessions[0].onresult({ results: [{ 0: { transcript: 'first thought' } }] });
  f.sessions[0].onend();
  assert.equal(f.speech.isActive(), true);
  f.tick();
  assert.equal(f.sessions.length, 2);
  f.sessions[1].onresult({ results: [{ 0: { transcript: 'second thought' } }] });
  assert.deepEqual(f.texts, ['first thought', 'first thought second thought']);
  assert.deepEqual(f.stopped, []);
});

test('manual stop cancels a pending restart and cannot turn listening back on', () => {
  const f = fixture();
  f.speech.start();
  f.sessions[0].onend();
  f.speech.stop();
  f.tick();
  assert.equal(f.sessions.length, 1);
  assert.equal(f.speech.isActive(), false);
  assert.deepEqual(f.stopped, [undefined]);
});

test('manual stop of an active session waits for its end and never restarts', () => {
  const f = fixture();
  f.speech.start();
  f.speech.stop();
  f.sessions[0].onend();
  f.tick();
  assert.equal(f.sessions.length, 1);
  assert.equal(f.speech.isActive(), false);
  assert.deepEqual(f.stopped, [undefined]);
});

test('no-speech stays recoverable, while microphone permission loss stops safely', () => {
  const f = fixture();
  f.speech.start();
  f.sessions[0].onerror({ error: 'no-speech' });
  f.sessions[0].onend();
  f.tick();
  assert.equal(f.sessions.length, 2);
  f.sessions[1].onerror({ error: 'not-allowed' });
  assert.equal(f.speech.isActive(), false);
  assert.deepEqual(f.stopped, ['not-allowed']);
});
