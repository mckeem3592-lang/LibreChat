export type TrackSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: (track: MediaStreamTrack) => void;
  stop: () => void;
};

type Timer = ReturnType<typeof setTimeout>;

/** Keeps the selected MacBook track open across Chrome recognition sessions.
 * A session may end at a pause even with continuous=true; only the owner stops
 * dictation, and each new session appends to the text already captured. */
export function createPersistentMacSpeech({
  track,
  createRecognition,
  language,
  onTranscript,
  onStopped,
  schedule = setTimeout,
  cancel = clearTimeout,
}: {
  track: MediaStreamTrack;
  createRecognition: () => TrackSpeechRecognition;
  language: string;
  onTranscript: (text: string) => void;
  onStopped: (error?: string) => void;
  schedule?: (callback: () => void, delay: number) => Timer;
  cancel?: (timer: Timer) => void;
}) {
  let desired = false;
  let finished = false;
  let recognition: TrackSpeechRecognition | null = null;
  let restartTimer: Timer | null = null;
  let stopTimer: Timer | null = null;
  let prefix = '';
  let current = '';

  const clearTimers = () => {
    if (restartTimer != null) cancel(restartTimer);
    if (stopTimer != null) cancel(stopTimer);
    restartTimer = null;
    stopTimer = null;
  };

  const finish = (error?: string) => {
    if (finished) return;
    finished = true;
    desired = false;
    clearTimers();
    const active = recognition;
    recognition = null;
    try { active?.stop(); } catch { /* The session may already be closed. */ }
    onStopped(error);
  };

  const beginSession = () => {
    restartTimer = null;
    if (!desired || finished) return;
    if (track.readyState !== 'live') {
      finish('audio-capture');
      return;
    }
    try {
      const active = createRecognition();
      active.lang = language;
      active.continuous = true;
      active.interimResults = true;
      active.onresult = (event) => {
        if (recognition !== active || !desired) return;
        current = Array.from(event.results).map((result) => result[0].transcript).join(' ').trim();
        onTranscript([prefix, current].filter(Boolean).join(' '));
      };
      active.onerror = (event) => {
        if (recognition !== active || !desired) return;
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        finish(event.error ?? 'unknown');
      };
      active.onend = () => {
        if (recognition !== active) return;
        recognition = null;
        if (!desired) {
          finish();
          return;
        }
        prefix = [prefix, current].filter(Boolean).join(' ');
        current = '';
        restartTimer = schedule(beginSession, 250);
      };
      recognition = active;
      active.start(track);
    } catch {
      finish('start-failed');
    }
  };

  return {
    start() {
      if (desired || finished) return;
      desired = true;
      beginSession();
    },
    stop() {
      if (finished || !desired) return;
      desired = false;
      if (restartTimer != null) {
        cancel(restartTimer);
        restartTimer = null;
      }
      if (!recognition) {
        finish();
        return;
      }
      try {
        recognition.stop();
        if (!finished) stopTimer = schedule(() => finish(), 1500);
      } catch {
        finish();
      }
    },
    isActive: () => desired && !finished,
  };
}
