/**
 * The gauntlet's zeros are not results. Checked against the committed book, not a fixture: the rule has to hold for
 * every strategy the executor actually serves.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gauntletTraded, type Evidence } from './strategyBook';

const DETAIL = path.resolve(import.meta.dirname, '../../server/data/strategies/detail');
const book = fs
  .readdirSync(DETAIL)
  .map((f) => JSON.parse(fs.readFileSync(path.join(DETAIL, f), 'utf8')) as { slug: string; evidence: Evidence | null });

describe('gauntletTraded', () => {
  it('is false for a strategy the gauntlet never saw trade — b100_mtf_1', () => {
    const s = book.find((b) => b.slug === 'b100_mtf_1')!;
    expect(gauntletTraded(s.evidence)).toBe(false);
  });

  it('is true for one it traded — liq_squeeze_break_perp, 107 unseen trades', () => {
    const s = book.find((b) => b.slug === 'liq_squeeze_break_perp')!;
    expect(gauntletTraded(s.evidence)).toBe(true);
  });

  it('is false with no evidence at all', () => {
    expect(gauntletTraded(null)).toBe(false);
  });

  it('never calls a strategy that did not trade a survivor', () => {
    for (const s of book) if (!gauntletTraded(s.evidence)) expect(s.evidence?.survives ?? false, s.slug).toBe(false);
  });
});
