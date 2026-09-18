/**
 * The executor's answers, read the way the screens read them: an export counted by its
 * records, and a daily limit drawn from one basis.
 *
 * Pure functions over response shapes. The transport is stubbed only because `system.ts` imports it — nothing here
 * makes a request — and the files are built the way `server/src/audit/log.ts` and `/pnl/disposals.csv` build them.
 */
import { describe, expect, it, vi } from 'vitest';
import { exportRecords, limitsView, type Limits } from './system';

vi.mock('./api', () => ({ api: {}, ApiError: class ApiError extends Error {} }));

describe('an export is counted by its records, not its lines', () => {
  const TRAIL_HEADER = 'seq,at,agent,action,detail,amount,kind,signature,prev_hash,hash';
  const DISPOSALS_HEADER = 'date,symbol,units,proceeds_usd,cost_basis_usd,gain_loss_usd,basis_method,basis_known';

  it('counts the trail’s rows and not its verification footer', () => {
    const csv = [
      TRAIL_HEADER,
      '1,2026-09-14T09:00:00Z,xorr,Wallet connected,,,risk,,0x0,0x1',
      '2,2026-09-14T09:05:00Z,xorr,Bought 0.1234 XBTC,"$250 at $2,026.00. Weekly buy.",,trade,0xabc,0x1,0x2',
    ].join('\n');
    expect(exportRecords(`${csv}\n# chain_verified=true rows=2`, 'csv')).toBe(2);
  });

  it('keeps a quoted line break, a doubled quote and a CRLF inside one record', () => {
    const csv = [
      TRAIL_HEADER,
      '1,2026-09-14T09:00:00Z,Drawdown Guard,BTC above $200k,"It said ""above"".\nTwice.",,risk,,0x0,0x1',
    ].join('\r\n');
    expect(exportRecords(`${csv}\r\n# chain_verified=true rows=1`, 'csv')).toBe(1);
  });

  it('calls an empty trail empty — it used to come back as two rows', () => {
    expect(exportRecords(`${TRAIL_HEADER}\n\n# chain_verified=true rows=0`, 'csv')).toBe(0);
  });

  it('does not count the disposals file’s totals row as a sale', () => {
    const csv = [
      DISPOSALS_HEADER,
      '2026-09-14T09:00:00.000Z,XBTC,0.5,1250,1000,250,average_cost,yes',
      '2026-09-14T10:00:00.000Z,WOKB,0.001,95,0,0,average_cost,no',
      ',,,,,250.00,,',
    ].join('\n');
    expect(exportRecords(csv, 'csv')).toBe(2);
    expect(exportRecords(`${DISPOSALS_HEADER}\n,,,,,0.00,,`, 'csv')).toBe(0);
  });

  it('counts the pretty-printed trail’s rows, not its lines', () => {
    const rows = [1, 2, 3].map((seq) => ({ seq, action: 'Skipped XBTC', detail: 'The daily cap is spent.' }));
    const json = JSON.stringify({ walletId: 'w', verified: { ok: true, checked: 3, intact: 3 }, rows }, null, 2);
    expect(json.split('\n').length).toBeGreaterThan(20);
    expect(exportRecords(json, 'json')).toBe(3);
    expect(exportRecords(JSON.stringify({ walletId: 'w', verified: { ok: true }, rows: [] }), 'json')).toBe(0);
    expect(exportRecords('[{"a":1},{"a":2}]', 'json')).toBe(2);
  });

  it('says a file that does not read as what it claims is not whole — which is not the same as empty', () => {
    expect(exportRecords('{"rows": [', 'json')).toBeUndefined();
    expect(exportRecords('{"walletId":"w"}', 'json')).toBeUndefined();
  });
});

describe('the daily limit is drawn from one basis', () => {
  const live = (over: Partial<Limits>): Limits => ({
    dailyCapUsd: 1_600,
    spentTodayUsd: 225,
    remainingUsd: 1_375,
    revoked: false,
    granted: true,
    expiresAt: Date.UTC(2026, 8, 20),
    ...over,
  });

  it('agrees with itself when the contract and the executor agree', () => {
    expect(limitsView(live({}), false)).toEqual({ left: 1_375, spent: 225, fraction: 225 / 1_600, agree: true });
  });

  it('draws the stricter tally when they differ, and says they differ instead of printing a spend that does not add up', () => {
    // Measured on the fork: the contract had $908.05 spent, the executor's own tally $954.05.
    const view = limitsView(live({ dailyCapUsd: 2_810, spentTodayUsd: 908.05, remainingUsd: 1_855.95 }), false);
    expect(view.left).toBe(1_855.95);
    expect(view.spent).toBeCloseTo(954.05, 2);
    expect(view.left + view.spent).toBeCloseTo(2_810, 6);
    expect(view.fraction).toBeCloseTo(954.05 / 2_810, 6);
    expect(view.agree).toBe(false);
  });

  it('treats a cent of rounding between the two sources as agreement', () => {
    expect(limitsView(live({ spentTodayUsd: 225.004, remainingUsd: 1_374.996 }), false).agree).toBe(true);
  });

  it('fills the bar, and no further, when the executor’s tally has used the whole cap', () => {
    expect(limitsView(live({ dailyCapUsd: 100, spentTodayUsd: 60, remainingUsd: 0 }), false)).toEqual({
      left: 0,
      spent: 100,
      fraction: 1,
      agree: false,
    });
  });

  it('draws what the contract spent for a permission that cannot spend, and compares nothing', () => {
    // A revoked grant comes back with a zero cap; `spent / 0` is Infinity, which drew a full bar.
    expect(limitsView(live({ dailyCapUsd: 0, spentTodayUsd: 480, remainingUsd: 0, revoked: true }), false)).toEqual({
      left: 0,
      spent: 480,
      fraction: 0,
      agree: true,
    });
    // Expired: the remainder is zero for a reason of its own, not because anything was spent.
    expect(limitsView(live({ spentTodayUsd: 0, remainingUsd: 0 }), true)).toEqual({
      left: 0,
      spent: 0,
      fraction: 0,
      agree: true,
    });
    expect(limitsView(live({ dailyCapUsd: 0, spentTodayUsd: 0, remainingUsd: 0, granted: false }), false).agree).toBe(true);
  });
});
