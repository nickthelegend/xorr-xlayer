/**
 * The system prompt has to say where the agent is.
 *
 * Momentum Scout's role is "rides breakouts on liquid majors". That phrase has no venue attached,
 * and a model resolves it the way it is used most often: foreign exchange. Asked "what are you
 * watching right now", it answered — in the agent's own voice, on screen — "I'm scanning the major
 * FX pairs for clear breakout signals... the focus is on EUR/USD and GBP/USD". This app trades spot
 * tokens on Base through 1inch. It has never had access to a currency pair.
 *
 * The voice gate cannot catch that. There is no digit in it, no emoji, no exclamation mark, two
 * sentences — it passes every rule and lands as fact. Structural enforcement works on the SHAPE of
 * a message; nothing but context can fix its SUBJECT, so the venue is pinned here instead.
 */
import { describe, expect, it } from 'vitest';
import { PERSONAS, systemPrompt, type Venue } from './personas.js';

const TONE = 'Dry. Plain. No jokes about money.';
const VENUE: Venue = { chain: 'Base', tradable: ['WETH', 'USDC', 'CBBTC', 'NVDAc'] };

describe('the venue', () => {
  it('names the chain and every tradable symbol', () => {
    const p = systemPrompt(PERSONAS['momentum-scout'], TONE, VENUE);
    expect(p).toContain('Base');
    for (const s of VENUE.tradable) expect(p).toContain(s);
  });

  it('rules out the markets the app cannot reach', () => {
    const p = systemPrompt(PERSONAS['momentum-scout'], TONE, VENUE);
    expect(p).toMatch(/foreign exchange/i);
    expect(p).toMatch(/no access/i);
  });

  it('tells the agent what to do when asked about one anyway', () => {
    // Silence is not the fix — a model with nothing to say invents. It needs an out.
    const p = systemPrompt(PERSONAS['momentum-scout'], TONE, VENUE);
    expect(p).toMatch(/say plainly that you do not trade it/i);
  });

  it('reaches every persona, not just the one that got caught', () => {
    for (const persona of Object.values(PERSONAS)) {
      const p = systemPrompt(persona, TONE, VENUE);
      expect(p, persona.id).toContain('WETH');
      expect(p, persona.id).toMatch(/no access/i);
    }
  });
});

describe('without a venue', () => {
  it('still builds a prompt, and still carries the voice rules', () => {
    // The parameter is optional so `personas.ts` stays a pure data module readable without a chain.
    const p = systemPrompt(PERSONAS['yield-keeper'], TONE);
    expect(p).toContain('NEVER write a number');
    expect(p).not.toMatch(/WHERE YOU ARE/);
  });
});

describe('the persona bible itself', () => {
  it('gives every persona lines it would never write — the useful half', () => {
    for (const persona of Object.values(PERSONAS)) {
      expect(persona.says.length, persona.id).toBeGreaterThan(0);
      expect(persona.neverSays.length, persona.id).toBeGreaterThan(0);
    }
  });

  it('keeps its own example lines inside the rules it states', () => {
    // A system prompt whose examples break its own rules teaches the model to break them.
    for (const persona of Object.values(PERSONAS)) {
      for (const line of [...persona.says, ...persona.neverSays]) {
        expect(line, `${persona.id}: ${line}`).not.toMatch(/\d/);
        expect(line, `${persona.id}: ${line}`).not.toContain('!');
      }
    }
  });
});
