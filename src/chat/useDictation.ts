/**
 * Speaking a question instead of typing it — where the platform can hear.
 *
 * The browser's own speech recognition (the Web Speech API, in Chrome, Edge and Safari) writes what is
 * said into the draft, after whatever was already typed. Nothing is sent until you press send, so a
 * misheard word is fixed before it is asked. A native build has no recogniser installed and neither
 * does Firefox, so there `supported` is false and the microphone is not drawn at all — rather than drawn
 * and refusing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

type RecognitionResultList = {
  length: number;
  [index: number]: { 0: { transcript: string } };
};

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: RecognitionResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

type RecognitionClass = new () => Recognition;

function recogniser(): RecognitionClass | undefined {
  if (Platform.OS !== 'web' || typeof globalThis === 'undefined') return undefined;
  const w = globalThis as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export type Dictation = {
  supported: boolean;
  listening: boolean;
  /** Why the last attempt heard nothing, in words. */
  error?: string;
  /** Starts listening; what is heard is written after `typed`. */
  start: (typed: string) => void;
  stop: () => void;
};

export function useDictation(onDraft: (text: string) => void): Dictation {
  const Recogniser = recogniser();
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef<Recognition | null>(null);
  const write = useRef(onDraft);

  useEffect(() => {
    write.current = onDraft;
  }, [onDraft]);

  // A recogniser left running after the chat closes would keep the microphone open.
  useEffect(() => () => active.current?.abort(), []);

  const start = useCallback(
    (typed: string) => {
      if (!Recogniser || active.current) return;
      const r = new Recogniser();
      const nav = (globalThis as { navigator?: { language?: string } }).navigator;
      r.lang = nav?.language ?? 'en-US';
      r.interimResults = true;
      r.continuous = false;
      const before = typed.trim();
      r.onresult = (event) => {
        let heard = '';
        for (let i = 0; i < event.results.length; i++) heard += event.results[i]![0].transcript;
        write.current(before ? `${before} ${heard.trim()}` : heard.trim());
      };
      r.onerror = (event) => {
        setError(
          event.error === 'not-allowed' || event.error === 'service-not-allowed'
            ? 'The microphone was not allowed, so nothing was heard.'
            : event.error === 'no-speech'
              ? 'Nothing was heard. Try again.'
              : 'That could not be heard. Try again, or type it.',
        );
      };
      r.onend = () => {
        active.current = null;
        setListening(false);
      };
      active.current = r;
      setError(undefined);
      setListening(true);
      r.start();
    },
    [Recogniser],
  );

  const stop = useCallback(() => active.current?.stop(), []);

  return { supported: !!Recogniser, listening, error, start, stop };
}
