/**
 * The receipt file, and what may not be in it.
 *
 * A receipt for something that did not happen is not a weaker receipt, it is a false one. So the
 * cases that matter most here are the exclusions: a blocked run, a failed one, and anything the
 * executor believed it filled but cannot point at a transaction for.
 */
import { describe, expect, it } from 'vitest';
import { FILLS_SQL, csvCell, fillsCsv, type FillRow } from './fills.js';

const fill = (over: Partial<FillRow> = {}): FillRow => ({
  runId: 'run-1',
  at: new Date('2026-09-17T09:30:00.000Z'),
  symbol: 'NVDAx',
  side: 'buy',
  strategy: 'Weekly NVDAx',
  units: '1.15343000',
  price: '216.74480000',
  usd: '250.00',
  venue: 'jupiter-route',
  signature: '5Gh2k1',
  ...over,
});

const lines = (csv: string) => csv.split('\n');
const cells = (csv: string, row: number) => lines(csv)[row]!.split(',');

describe('what the query will and will not return', () => {
  it('takes only runs that reached filled', () => {
    // A blocked run is a real and important record — the moment a cap did its job — and it belongs
    // on the audit trail, not on a receipt, because nothing moved.
    expect(FILLS_SQL).toContain("r.status = 'filled'");
  });

  it('takes only runs that can point at a transaction', () => {
    expect(FILLS_SQL).toContain('r.signature IS NOT NULL');
  });

  it('takes only runs that finished', () => {
    expect(FILLS_SQL).toContain('r.finished_at IS NOT NULL');
  });

  it('scopes to the caller’s wallet through the strategy that owns the run', () => {
    // `strategy_runs` has no wallet of its own. Without the join one account's receipts would
    // appear in another's file.
    expect(FILLS_SQL).toContain('JOIN strategies s ON s.id = r.strategy_id');
    expect(FILLS_SQL).toContain('s.wallet_id = $1');
  });

  it('reads the time the fill finished, not the time it was claimed', () => {
    expect(FILLS_SQL).toContain('r.finished_at   AS at');
    expect(FILLS_SQL).toContain('ORDER BY r.finished_at ASC');
  });

  it('reads the venue, so the file cannot call a vault settlement a Jupiter swap', () => {
    expect(FILLS_SQL).toContain('r.venue');
  });
});

describe('the file', () => {
  it('has a header naming every column', () => {
    expect(lines(fillsCsv([]))[0]).toBe(
      'date,symbol,side,units,price_usd,usd,venue,strategy,signature,run_id',
    );
  });

  it('writes one row per fill, in the columns the header names', () => {
    const csv = fillsCsv([fill()]);
    expect(cells(csv, 1)).toEqual([
      '2026-09-17T09:30:00.000Z',
      'NVDAx',
      'buy',
      '1.15343000',
      '216.74480000',
      '250.00',
      'jupiter-route',
      'Weekly NVDAx',
      '5Gh2k1',
      'run-1',
    ]);
  });

  it('carries the signature, which is what makes a row a receipt rather than a claim', () => {
    expect(fillsCsv([fill({ signature: 'abc123' })])).toContain('abc123');
  });

  it('says in words when there is nothing to export', () => {
    // A header on its own is indistinguishable from an export that failed, and someone who has
    // never had a fill is entitled to know that is what they are looking at.
    expect(fillsCsv([])).toBe(
      'date,symbol,side,units,price_usd,usd,venue,strategy,signature,run_id\n# no settled fills recorded',
    );
  });

  it('adds no total row', () => {
    /*
     * Buys and sales are different signs of different things, and a column adding them together
     * would be a number with no meaning. `/pnl/disposals.csv` totals because every row there is a
     * realised gain, which is one quantity.
     */
    const csv = fillsCsv([fill(), fill({ runId: 'run-2', side: 'sell' })]);
    expect(lines(csv)).toHaveLength(3);
    expect(lines(csv).at(-1)).toContain('run-2');
  });
});

describe('a fill the executor could not fully measure', () => {
  it('is kept, with the unmeasured cells blank', () => {
    /*
     * It settled and the signature proves it. Dropping it would understate what happened — the
     * same reasoning `/pnl/disposals.csv` gives for keeping a disposal with no recorded basis.
     */
    const csv = fillsCsv([fill({ units: null, price: null, usd: null })]);
    const row = cells(csv, 1);
    expect(row[3]).toBe('');
    expect(row[4]).toBe('');
    expect(row[5]).toBe('');
    // Still a receipt: the transaction and the asset are there.
    expect(row[1]).toBe('NVDAx');
    expect(row[8]).toBe('5Gh2k1');
  });

  it('never writes a zero for a quantity nobody measured', () => {
    // "0.0000 at $0.00" is a fill that lost the user everything, on paper.
    const csv = fillsCsv([fill({ units: null, price: null })]);
    expect(csv).not.toContain(',0,');
    expect(csv).not.toContain('null');
  });

  it('leaves a side an older row never recorded blank', () => {
    expect(cells(fillsCsv([fill({ side: null })]), 1)[2]).toBe('');
  });
});

describe('escaping', () => {
  it('quotes a strategy label containing a comma', () => {
    /*
     * A label is user-written. "Weekly WETH, big" would otherwise shift every column after it by
     * one and silently corrupt the file for whoever opened it next.
     */
    const csv = fillsCsv([fill({ strategy: 'Weekly WETH, big' })]);
    expect(csv).toContain('"Weekly WETH, big"');
    expect(cells(csv, 1)).toHaveLength(11); // the comma is inside one quoted cell
  });

  it('doubles a quote inside a cell', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes a newline rather than starting a new record', () => {
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('leaves an ordinary cell alone', () => {
    expect(csvCell('NVDAx')).toBe('NVDAx');
  });

  it('writes an absent value as empty, not as the word null', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('writes a date as an unambiguous instant', () => {
    expect(csvCell(new Date('2026-09-17T09:30:00Z'))).toBe('2026-09-17T09:30:00.000Z');
  });
});
