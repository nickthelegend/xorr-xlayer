/**
 * The tone dial — PLAN.md §3.2 / 11.4.
 *
 * Changes VOICE segments only. It cannot change a single number, label, or button: facts are
 * rendered by src/format from structured values, and the tone never reaches them.
 *
 * `description` is what a person reads when choosing, so it is one short line. `instruction` is what
 * the model is told; server/src/bot/tone.ts mirrors it and is the copy that goes into the prompt. It
 * is written for a model, and no screen shows it.
 */
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ToneId = 'dry' | 'sharp' | 'flat';

export const TONES: { id: ToneId; label: string; description: string; instruction: string }[] = [
  {
    id: 'dry',
    label: 'Dry',
    description: 'Understated, with the odd dry aside.',
    instruction:
      'Write plainly with dry understatement. One short aside at most, and only about the market — never about the user or their money.',
  },
  {
    id: 'sharp',
    label: 'Sharp',
    description: 'Opinionated about markets, careful with your money.',
    instruction:
      'Be more opinionated and direct about market conditions. Stay factual about positions, sizes and limits. Never mock the user.',
  },
  {
    id: 'flat',
    label: 'Flat',
    description: 'Just what happened.',
    instruction: 'No personality. State only what happened and what will happen next.',
  },
];

const KEY = 'xorr-tone';
export const DEFAULT_TONE: ToneId = 'dry';

export function toneInstruction(tone: ToneId): string {
  return TONES.find((t) => t.id === tone)?.instruction ?? TONES[0]!.instruction;
}

export function useTone() {
  const [tone, setToneState] = useState<ToneId>(DEFAULT_TONE);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((v) => {
        if (v === 'dry' || v === 'sharp' || v === 'flat') setToneState(v);
      })
      .catch(() => undefined);
  }, []);

  const setTone = useCallback((t: ToneId) => {
    setToneState(t);
    void AsyncStorage.setItem(KEY, t).catch(() => undefined);
  }, []);

  return { tone, setTone };
}
