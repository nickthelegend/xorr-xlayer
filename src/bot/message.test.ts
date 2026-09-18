/**
 * PLAN.md 11.3 — the voice/facts split is the MECHANISM that keeps the bot trustworthy.
 * The prompt is only the manners.
 */
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_TYPES,
  VoiceContainsNumberError,
  executorSentence,
  fact,
  renderFact,
  renderSegments,
  voice,
} from './message';
import { MINUS } from '../format';

describe('a number can never live in a voice segment', () => {
  it('accepts prose with no numbers', () => {
    expect(voice('SOL just cleared its high on twice the usual volume.').text).toContain('SOL');
    expect(voice('Funding is flat, so this is not a crowded long yet.').kind).toBe('voice');
  });

  it('rejects digits', () => {
    expect(() => voice('Filled at $88.32.')).toThrow(VoiceContainsNumberError);
    expect(() => voice('Bought 12.4 SOL')).toThrow(VoiceContainsNumberError);
  });

  it('rejects number WORDS — the obvious way a model smuggles a quantity past a digit check', () => {
    expect(() => voice('I put about twelve SOL to work.')).toThrow(VoiceContainsNumberError);
    expect(() => voice('That is half your daily cap.')).toThrow(VoiceContainsNumberError);
    expect(() => voice('It doubled overnight.')).toThrow(VoiceContainsNumberError);
  });

  it('a fact must name where its number came from', () => {
    expect(() => fact(88.32, 'price', '')).toThrow();
    expect(fact(2481.11, 'price', '1inch:WETH').source).toBe('1inch:WETH');
  });
});

describe('facts are formatted by code, never by the model', () => {
  it('formats each kind through the audited formatters', () => {
    expect(renderFact(fact(4862.18, 'money', 'db'))).toBe('$4,862.18');
    expect(renderFact(fact(-96, 'signedMoney', 'db'))).toBe(`${MINUS}$96.00`);
    expect(renderFact(fact(66560, 'price', 'coingecko'))).toBe('$66,560');
    expect(renderFact(fact(2.4, 'percent', 'calc'))).toBe('+2.4%');
    expect(renderFact(fact(12.4, 'quantity', 'fill'))).toBe('12.4000');
    expect(renderFact(fact(182_400_000, 'compact', 'venue'))).toBe('$182.4M');
  });

  it('renders a mixed message cleanly', () => {
    const out = renderSegments([
      voice('Filled.'),
      fact(12.4, 'quantity', 'tx'),
      voice('SOL, stop is set at'),
      fact(87.44, 'price', 'tx'),
      voice('.'),
    ]);
    expect(out).toBe('Filled. 12.4000 SOL, stop is set at $87.44.');
    // No double spaces, no space before punctuation.
    expect(out).not.toMatch(/\s{2}/);
    expect(out).not.toMatch(/\s[.,]/);
  });

  it('every number in a rendered message traces to a fact with a source', () => {
    const segments = [
      voice('Bought the breakout.'),
      fact(4.2, 'quantity', 'tx:5xy'),
      voice('SOL at'),
      fact(88.1, 'price', 'tx:5xy'),
    ];
    const facts = segments.filter((s) => s.kind === 'facts');
    for (const f of facts) expect(f.source.length).toBeGreaterThan(0);
    // and the voice half is genuinely number-free
    for (const s of segments.filter((s) => s.kind === 'voice')) {
      expect(s.text).not.toMatch(/\d/);
    }
  });
});

describe("an executor's sentence keeps its numbers as facts", () => {
  const FILLED = 'Bought 0.0020 WETH at $2,517.86. Your existing exit on WETH stays as it is.';

  it('never throws on the fill the executor sends, and reads exactly as it was sent', () => {
    const segments = executorSentence(FILLED, 'executor:decide');
    expect(renderSegments(segments)).toBe(FILLED);
    // voice() refuses the whole sentence — the throw the chat reported as "did not reach the executor".
    expect(() => voice(FILLED)).toThrow(VoiceContainsNumberError);
  });

  it('puts every number in a fact that names its source, and no number in voice', () => {
    const segments = executorSentence('That is half your cap: $800 of $1,600 today.', 'executor:limits');
    for (const s of segments) {
      if (s.kind === 'voice') expect(s.text).not.toMatch(/\d|\bhalf\b/i);
      else expect(s.source).toBe('executor:limits');
    }
    expect(segments.filter((s) => s.kind === 'facts').map((s) => (s.kind === 'facts' ? s.value : ''))).toEqual([
      'half',
      '$800',
      '$1,600',
    ]);
  });

  it('is all voice when the sentence has no number', () => {
    expect(executorSentence('That proposal no longer exists.', 'executor:decide')).toEqual([
      { kind: 'voice', text: 'That proposal no longer exists.' },
    ]);
  });
});

describe('the message-type registry', () => {
  it('covers every kind the thread renders after the pivot', () => {
    expect(MESSAGE_TYPES).toContain('proposal');
    expect(MESSAGE_TYPES).toContain('dca-receipt');
    expect(MESSAGE_TYPES).toContain('blocked');
    expect(MESSAGE_TYPES).toContain('expired');
    expect(MESSAGE_TYPES).toContain('strategy-created');
    expect(MESSAGE_TYPES.length).toBeGreaterThanOrEqual(10);
  });
});
