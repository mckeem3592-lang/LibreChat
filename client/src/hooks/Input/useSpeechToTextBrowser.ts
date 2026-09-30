import { useCallback, useEffect, useRef, useState } from 'react';
import { useRecoilState } from 'recoil';
import { useToastContext } from '@librechat/client';
import { useGetCustomConfigSpeechQuery } from 'librechat-data-provider/react-query';
import SpeechRecognitionImport, { useSpeechRecognition } from 'react-speech-recognition';
import { useLocalize } from '~/hooks';
import store from '~/store';
import { openMacBuiltInMicrophone } from './selectMacBuiltInMicrophone';

type TrackSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void)
    | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: (track: MediaStreamTrack) => void;
  stop: () => void;
};

const isMacChrome = () =>
  typeof navigator !== 'undefined' &&
  /Macintosh|MacIntel/.test(navigator.userAgent) &&
  /Chrome\/\d+/.test(navigator.userAgent);

const trackRecognitionConstructor = () => {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: new () => TrackSpeechRecognition;
    webkitSpeechRecognition?: new () => TrackSpeechRecognition;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
};

type SpeechRecognitionController = Pick<
  typeof SpeechRecognitionImport,
  'startListening' | 'stopListening'
>;
type SpeechRecognitionModule = Partial<SpeechRecognitionController> & {
  default?: Partial<SpeechRecognitionController>;
};

const hasSpeechRecognitionController = (
  controller?: Partial<SpeechRecognitionController>,
): controller is SpeechRecognitionController =>
  typeof controller?.startListening === 'function' &&
  typeof controller.stopListening === 'function';

const speechRecognitionModule = SpeechRecognitionImport as SpeechRecognitionModule;
const SpeechRecognition = hasSpeechRecognitionController(speechRecognitionModule)
  ? speechRecognitionModule
  : speechRecognitionModule.default;

const useSpeechToTextBrowser = (
  setText: (text: string) => void,
  onTranscriptionComplete: (text: string) => void,
) => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data: speechConfig } = useGetCustomConfigSpeechQuery({ enabled: true });
  const sttExternal = Boolean(speechConfig?.sttExternal);

  const lastTranscript = useRef<string | null>(null);
  const lastInterim = useRef<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>();
  const macRecognitionRef = useRef<TrackSpeechRecognition | null>(null);
  const macStreamRef = useRef<MediaStream | null>(null);
  const macStartingRef = useRef(false);
  const [macListening, setMacListening] = useState(false);
  const [macStarting, setMacStarting] = useState(false);
  const [macFinalTranscript, setMacFinalTranscript] = useState('');
  const [macInterimTranscript, setMacInterimTranscript] = useState('');
  const [autoSendText] = useRecoilState(store.autoSendText);
  const [languageSTT] = useRecoilState<string>(store.languageSTT);
  const [autoTranscribeAudio] = useRecoilState<boolean>(store.autoTranscribeAudio);

  const {
    listening,
    finalTranscript,
    resetTranscript,
    interimTranscript,
    isMicrophoneAvailable,
    browserSupportsSpeechRecognition,
  } = useSpeechRecognition();
  const isListening = isMacChrome() ? macListening : listening;
  const activeFinalTranscript = isMacChrome() ? macFinalTranscript : finalTranscript;
  const activeInterimTranscript = isMacChrome() ? macInterimTranscript : interimTranscript;

  const releaseMacMicrophone = useCallback(() => {
    macStreamRef.current?.getTracks().forEach((track) => track.stop());
    macStreamRef.current = null;
    macRecognitionRef.current = null;
    macStartingRef.current = false;
    setMacStarting(false);
    setMacListening(false);
  }, []);

  useEffect(() => {
    return () => {
      macRecognitionRef.current?.stop();
      macStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (activeInterimTranscript === '') {
      return;
    }

    if (lastInterim.current === activeInterimTranscript) {
      return;
    }

    setText(activeInterimTranscript);
    lastInterim.current = activeInterimTranscript;
  }, [setText, activeInterimTranscript]);

  useEffect(() => {
    if (activeFinalTranscript === '') {
      return;
    }

    if (lastTranscript.current === activeFinalTranscript) {
      return;
    }

    setText(activeFinalTranscript);
    lastTranscript.current = activeFinalTranscript;
    if (autoSendText > -1 && activeFinalTranscript.length > 0) {
      timeoutRef.current = setTimeout(() => {
        onTranscriptionComplete(activeFinalTranscript);
        resetTranscript();
      }, autoSendText * 1000);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [setText, onTranscriptionComplete, resetTranscript, activeFinalTranscript, autoSendText]);

  const toggleMacListening = useCallback(async () => {
    if (macRecognitionRef.current) {
      macRecognitionRef.current.stop();
      return;
    }
    if (macStartingRef.current) {
      return;
    }
    macStartingRef.current = true;
    setMacStarting(true);
    try {
      const Recognition = trackRecognitionConstructor();
      if (!Recognition || !navigator.mediaDevices?.enumerateDevices) {
        throw new Error('speech recognition unavailable');
      }
      const stream = await openMacBuiltInMicrophone(navigator.mediaDevices);
      macStreamRef.current = stream;
      const recognition = new Recognition();
      recognition.lang = languageSTT;
      recognition.continuous = autoTranscribeAudio;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        const results = Array.from(event.results);
        setMacFinalTranscript(
          results
            .filter((result) => result.isFinal)
            .map((result) => result[0].transcript)
            .join(' '),
        );
        setMacInterimTranscript(results.map((result) => result[0].transcript).join(' '));
      };
      recognition.onerror = () => {
        showToast({ message: localize('com_ui_microphone_unavailable'), status: 'error' });
        releaseMacMicrophone();
      };
      recognition.onend = releaseMacMicrophone;
      macRecognitionRef.current = recognition;
      lastTranscript.current = null;
      lastInterim.current = null;
      setMacFinalTranscript('');
      setMacInterimTranscript('');
      recognition.start(stream.getAudioTracks()[0]);
      macStartingRef.current = false;
      setMacStarting(false);
      setMacListening(true);
    } catch {
      releaseMacMicrophone();
      showToast({ message: localize('com_ui_microphone_unavailable'), status: 'error' });
    }
  }, [autoTranscribeAudio, languageSTT, localize, releaseMacMicrophone, showToast]);

  const toggleListening = useCallback(() => {
    if (isMacChrome()) {
      void toggleMacListening();
      return;
    }
    if (!browserSupportsSpeechRecognition) {
      showToast({
        message: sttExternal
          ? localize('com_ui_speech_not_supported_use_external')
          : localize('com_ui_speech_not_supported'),
        status: 'error',
      });
      return;
    }

    if (!isMicrophoneAvailable) {
      showToast({
        message: localize('com_ui_microphone_unavailable'),
        status: 'error',
      });
      return;
    }

    if (!hasSpeechRecognitionController(SpeechRecognition)) {
      showToast({
        message: sttExternal
          ? localize('com_ui_speech_not_supported_use_external')
          : localize('com_ui_speech_not_supported'),
        status: 'error',
      });
      return;
    }

    if (isListening === true) {
      SpeechRecognition.stopListening();
    } else {
      SpeechRecognition.startListening({
        language: languageSTT,
        continuous: autoTranscribeAudio,
      });
    }
  }, [
    autoTranscribeAudio,
    browserSupportsSpeechRecognition,
    isListening,
    isMicrophoneAvailable,
    languageSTT,
    localize,
    showToast,
    sttExternal,
    toggleMacListening,
  ]);

  return {
    isListening,
    isLoading: macStarting,
    startRecording: toggleListening,
    stopRecording: toggleListening,
  };
};

export default useSpeechToTextBrowser;
