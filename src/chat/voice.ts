/**
 * Whether the agents can reply in this build.
 *
 * A reply is written by a language model, and a build without one answers every question with the same refusal. Offering
 * questions there offers a dead end, so a conversation needs to know before it offers any: the executor publishes it on
 * `/health` as `voice.configured`, read once and kept. A reply refused for want of a model says the same thing, which
 * covers an executor too old to publish it.
 *
 * `undefined` is not known: not read yet, or not published. A conversation then offers its questions, as it always did.
 */
import { create } from 'zustand';
import { system } from '@/data/system';

type VoiceState = {
  configured: boolean | undefined;
  /** Read `/health` once. Later calls cost nothing, and a read that failed is tried again by the next one. */
  read: () => Promise<void>;
  /** A reply came back refused because nothing in this build can write one. */
  refused: () => void;
};

let reading: Promise<void> | undefined;

export const useVoice = create<VoiceState>((set, get) => ({
  configured: undefined,
  read: () => {
    if (get().configured !== undefined) return Promise.resolve();
    reading ??= system
      .health()
      .then((health) => {
        const configured = health.voice?.configured;
        if (typeof configured === 'boolean') set({ configured });
      })
      .catch(() => undefined)
      .finally(() => {
        reading = undefined;
      });
    return reading;
  },
  refused: () => set({ configured: false }),
}));
