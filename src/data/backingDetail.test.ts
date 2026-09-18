/**
 * The drawer's rule is that absence is stated, not drawn as a dash, and that an attestation never
 * appears without its age. These cover the wording helpers that carry both.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { attestationAge, NO_RECORD, fetchBackingDetail } from './backingDetail';

describe('attestation age', () => {
  it('says how old every observation is, never implying "now" by omission', () => {
    expect(attestationAge(30)).toBe('just now');
    expect(attestationAge(600)).toBe('10 min ago');
    expect(attestationAge(3 * 3600)).toBe('3 hr ago');
    // A week-old attestation must read as a week old, not as a fresh one.
    expect(attestationAge(7 * 24 * 3600)).toBe('7 days ago');
  });

  it('crosses into days rather than printing an unreadable hour count', () => {
    expect(attestationAge(47 * 3600)).toBe('47 hr ago');
    expect(attestationAge(49 * 3600)).toBe('2 days ago');
  });
});

describe('missing values', () => {
  it('has a word for absence, so no field is ever a bare dash', () => {
    // A dash in a column of numbers reads as zero; "No record" cannot be misread that way.
    expect(NO_RECORD).toBe('No record');
    expect(NO_RECORD).not.toMatch(/^[-–—]$/);
  });
});

describe('fetchBackingDetail', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns null rather than a half-built drawer when the executor is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await fetchBackingDetail('NVDAx')).toBeNull();
  });

  it('returns null on a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    expect(await fetchBackingDetail('NOPEx')).toBeNull();
  });

  it('returns null for a body with no symbol, rather than rendering blanks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    expect(await fetchBackingDetail('NVDAx')).toBeNull();
  });

  it('passes a real detail through intact, nulls included', async () => {
    const detail = {
      symbol: 'NVDAx',
      name: 'NVIDIA Corporation',
      address: '0xa8ddb5cd96b5222afe198316e9a57caa642850d5',
      raw: '0xc845b2894dBddd03858fd2D643B4eF725fE0849d',
      issuer: {
        owner: null,
        minter: null,
        burner: null,
        pauser: null,
        multiplierUpdater: null,
        sanctionsList: null,
        upgradeAdmin: null,
        canMint: null,
        canPause: null,
        paused: null,
      },
      wrapper: { owner: null, pauser: null, upgradeAdmin: null, paused: false },
      supply: { raw: null, wrapped: null, wrappedAssets: null },
      reserves: { verified: false, reason: 'unreachable' },
      multiplier: { current: null, effectiveAt: null, pending: null, history: [] },
      attestationHistory: [],
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => detail })));

    const d = await fetchBackingDetail('NVDAx');
    // The nulls have to survive: they are what the screen renders as "No record".
    expect(d?.issuer.minter).toBeNull();
    expect(d?.supply.wrapped).toBeNull();
    expect(d?.wrapper.paused).toBe(false);
    expect(d?.multiplier.current).toBeNull();
  });
});
