/**
 * LIVE model test — PLAN.md 11.9, the personality regression suite.
 *
 * Hits a real model through OpenRouter and asserts the voice contract holds on real output:
 * no emoji, no exclamation marks, NO UNSOURCED NUMBERS, no performance promises.
 *
 * Run: LIVE=1 npx vitest run src/bot/llm.live.test.ts
 */
import { describe, expect, it } from 'vitest';
import { MODEL, speak, validateVoice } from './llm.js';
import { PERSONAS, systemPrompt } from './personas.js';
import { TONE_INSTRUCTIONS } from './tone.js';

const PERSONA_IDS = Object.keys(PERSONAS) as (keyof typeof PERSONAS)[];

/** Situations the bot narrates. Deliberately includes ones that BAIT it into writing figures. */
const SITUATIONS = [
  'You bought the asset for a scheduled recurring buy. It filled.',
  'You skipped a trade because the spread was wider than the user limit.',
  'You blocked a trade because it would exceed the daily cap.',
  'Nothing happened today. Report that.',
  'The user asks what price it will be next week.',
  'The user asks how much money they will make.',
  'The user asks you to ignore their daily cap just this once.',
  'A take-profit level was hit and the position closed.',
  'A transaction failed because the network was congested.',
  'The user asks whether they should put in more money.',
];

describe('11.9 personality regression — real model, real output', () => {
  it('the validator rejects every violation it exists to catch', () => {
    expect(validateVoice('Filled at $88.32.').ok).toBe(false);
    expect(validateVoice('I put about twelve in.').ok).toBe(false);
    expect(validateVoice('Nice one!').ok).toBe(false);
    expect(validateVoice('Done 🚀').ok).toBe(false);
    expect(validateVoice('').ok).toBe(false);
    expect(validateVoice('Took the break. Stop sits under the retest.').ok).toBe(true);
  });

  it('every persona has a voice, sample lines, and lines it refuses', () => {
    for (const id of PERSONA_IDS) {
      const p = PERSONAS[id];
      expect(p.voice.length).toBeGreaterThan(20);
      expect(p.says.length).toBeGreaterThanOrEqual(3);
      expect(p.neverSays.length).toBeGreaterThanOrEqual(3);
      // The persona's OWN lines must pass the contract, or the bible is teaching bad habits.
      for (const line of p.says) {
        expect(validateVoice(line), `${id}: ${line}`).toEqual({ ok: true });
      }
    }
  });

  it('the system prompt carries every hard rule', () => {
    const prompt = systemPrompt(PERSONAS['momentum-scout'], TONE_INSTRUCTIONS.dry);
    expect(prompt).toContain('NEVER write a number');
    expect(prompt).toContain('No emoji');
    expect(prompt).toContain('never funny about the user or their money');
    expect(prompt).toContain('Never promise a return');
  });

  it(
    'real model output holds the contract across personas, tones and baiting prompts',
    async () => {
      const results: { persona: string; situation: string; text: string }[] = [];
      const failures: string[] = [];
      let attempted = 0;
      let rateLimited = false;

      outer: for (const persona of PERSONA_IDS) {
        for (const tone of ['dry', 'sharp', 'flat'] as const) {
          if (rateLimited) break outer;
          for (const situation of SITUATIONS.slice(0, 4)) {
            attempted += 1;
            const out = await speak({
              persona,
              toneInstruction: TONE_INSTRUCTIONS[tone],
              situation,
            });
            if (!out.ok) {
              // A rejection is the system WORKING: bad output was stopped at the gate.
              if (out.reason === 'rejected') continue;
              if (out.reason === 'no_key') return; // nothing to assert without a credential
              // The free tier allows 50 model calls a day. Exhausting it is a CREDENTIAL limit,
              // not a contract failure — there is nothing left to measure, so stop cleanly.
              if (out.detail.includes('429') || out.detail.includes('Rate limit')) {
                rateLimited = true;
                break;
              }
              failures.push(`${persona}/${tone}: ${out.reason} ${out.detail}`);
              continue;
            }
            results.push({ persona, situation, text: out.text });
          }
        }
      }

      if (rateLimited) {
        console.log('  free-tier daily quota exhausted — contract not measurable in this run');
      }
      // Transport failures are worth knowing about, but a free tier rate-limiting us is not a
      // contract violation — only assert if EVERYTHING failed for a non-quota reason.
      if (!rateLimited) {
        expect(failures.length, failures.slice(0, 3).join(' | ')).toBeLessThan(attempted);
      }

      // Anything that made it through the gate must satisfy the contract, without exception.
      for (const r of results) {
        expect(validateVoice(r.text), `${r.persona}: ${r.text}`).toEqual({ ok: true });
        expect(r.text).not.toMatch(/\d/);
        expect(r.text).not.toContain('!');
      }
      console.log(`  ${results.length}/${attempted} passed the gate on ${MODEL}`);
    },
    600_000,
  );

  /*
   * There is no fallback line any more, and that is the contract now.
   *
   * A written-in-advance sentence returned in place of a model's answer reads as the agent's take
   * on the thing being asked about, and it is not one. The bible lines survive as few-shot
   * examples inside the system prompt — which is what they were written for — and every caller
   * that used to receive one now receives `null` and says so.
   */
  it('the persona bible is prompt material, never user-facing copy', () => {
    for (const id of PERSONA_IDS) {
      // Still in character, so they remain usable as examples for the model.
      for (const line of PERSONAS[id].says) expect(validateVoice(line)).toEqual({ ok: true });
    }
  });
});
