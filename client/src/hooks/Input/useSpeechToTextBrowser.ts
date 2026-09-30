import { useCallback, useEffect, useRef, useState } from 'react';
import { useRecoilState } from 'recoil';
import { useToastContext } from '@librechat/client';
import { useGetCustomConfigSpeechQuery } from 'librechat-data-provider/react-query';
import SpeechRecognitionImport, { useSpeechRecognition } from 'react-speech-recognition';
import { useLocalize } from '~/hooks';
import store from '~/store';
import { createPersistentMacSpeech, type TrackSpeechRecognition } from './persistentMacSpeech';
import { openMacBuiltInMicrophone } from './selectMacBuiltInMicrophone';

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
  const macSessionRef = useRef<ReturnType<typeof createPersistentMacSpeech> | null>(null);
  const macStreamRef = useRef<MediaStream | null>(null);
  const macStartingRef = useRef(false);
  const macShouldListenRef = useRef(false);
  const [macListening, setMacListening] = useState(false);
  const [macStarting, setMacStarting] = useState(false);
  const [macTranscript, setMacTranscript] = useState('');
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

  const releaseMacMicrophone = useCallback(() => {
    macShouldListenRef.current = false;
    macStreamRef.current?.getTracks().forEach((track) => track.stop());
    macStreamRef.current = null;
    macSessionRef.current = null;
    macStartingRef.current = false;
    setMacStarting(false);
    setMacListening(false);
  }, []);

  useEffect(() => {
    return () => {
      macShouldListenRef.current = false;
      macSessionRef.current?.stop();
      macStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!isMacChrome() || !macTranscript || lastTranscript.current === macTranscript) return;
    setText(macTranscript);
    lastTranscript.current = macTranscript;
  }, [macTranscript, setText]);

  useEffect(() => {
    if (isMacChrome() || interimTranscript === '') {
      return;
    }

    if (lastInterim.current === interimTranscript) {
      return;
    }

    setText(interimTranscript);
    lastInterim.current = interimTranscript;
  }, [setText, interimTranscript]);

  useEffect(() => {
    if (isMacChrome() || finalTranscript === '') {
      return;
    }

    if (lastTranscript.current === finalTranscript) {
      return;
    }

    setText(finalTranscript);
    lastTranscript.current = finalTranscript;
    if (autoSendText > -1 && finalTranscript.length > 0) {
      timeoutRef.current = setTimeout(() => {
        onTranscriptionComplete(finalTranscript);
        resetTranscript();
      }, autoSendText * 1000);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [setText, onTranscriptionComplete, resetTranscript, finalTranscript, autoSendText]);

  const stopMacListening = useCallback(() => {
    macShouldListenRef.current = false;
    setMacTranscript('');
    if (macSessionRef.current) macSessionRef.current.stop();
    else releaseMacMicrophone();
  }, [releaseMacMicrophone]);

  const startMacListening = useCallback(async () => {
    if (macShouldListenRef.current || macStartingRef.current || macSessionRef.current) return;
    macShouldListenRef.current = true;
    macStartingRef.current = true;
    setMacStarting(true);
    try {
      const Recognition = trackRecognitionConstructor();
      if (!Recognition || !navigator.mediaDevices?.enumerateDevices) {
        throw new Error('speech recognition unavailable');
      }
      const stream = await openMacBuiltInMicrophone(navigator.mediaDevices);
      if (!macShouldListenRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      macStreamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState !== 'live') throw new Error('MacBook audio track unavailable');
      lastTranscript.current = null;
      lastInterim.current = null;
      setMacTranscript('');
      const session = createPersistentMacSpeech({
        track,
        createRecognition: () => new Recognition(),
        language: languageSTT || navigator.language || 'en-US',
        onTranscript: setMacTranscript,
        onStopped: (error) => {
          releaseMacMicrophone();
          if (!error) return;
          showToast({ message: localize('com_ui_microphone_unavailable'), status: 'error' });
        },
      });
      macSessionRef.current = session;
      session.start();
      macStartingRef.current = false;
      setMacStarting(false);
      if (session.isActive()) setMacListening(true);
    } catch {
      releaseMacMicrophone();
      showToast({ message: localize('com_ui_microphone_unavailable'), status: 'error' });
    }
  }, [languageSTT, localize, releaseMacMicrophone, showToast]);

  const startListening = useCallback(() => {
    if (isMacChrome()) {
      void startMacListening();
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

    if (isListening) return;
    SpeechRecognition.startListening({
      language: languageSTT,
      continuous: autoTranscribeAudio,
    });
  }, [
    autoTranscribeAudio,
    browserSupportsSpeechRecognition,
    isListening,
    isMicrophoneAvailable,
    languageSTT,
    localize,
    showToast,
    sttExternal,
    startMacListening,
  ]);

  const stopListening = useCallback(() => {
    if (isMacChrome()) {
      stopMacListening();
    } else if (isListening && hasSpeechRecognitionController(SpeechRecognition)) {
      SpeechRecognition.stopListening();
    }
  }, [isListening, stopMacListening]);

  return {
    isListening,
    isLoading: macStarting,
    startRecording: startListening,
    stopRecording: stopListening,
  };
};

export default useSpeechToTextBrowser;
