import { describe, expect, it, vi } from 'vitest';

vi.mock('@/data/system', () => ({ system: { delegationParams: vi.fn() } }));
vi.mock('@/chain', () => ({ pinnedDelegation: undefined }));

const { contractToRead } = await import('./contractToRead');

const PIN = '0xf50a4ec95c07e497095ddad99a006cf44ceb7819' as const;

describe('contractToRead', () => {
  it('trusts the pinned contract and never asks the executor', async () => {
    let asked = false;
    expect(await contractToRead(PIN, async () => ((asked = true), { contract: '0x0000000000000000000000000000000000000001' }))).toBe(PIN);
    expect(asked).toBe(false);
  });
  it('reads the contract the executor names when the build pinned none', async () => {
    expect(await contractToRead(undefined, async () => ({ contract: PIN }))).toBe(PIN);
  });
  it('is unreadable, not "none", when the executor cannot be asked or names nothing usable', async () => {
    expect(await contractToRead(undefined, async () => { throw new Error('offline'); })).toBe('unreadable');
    expect(await contractToRead(undefined, async () => ({ contract: 'nope' }))).toBe('unreadable');
  });
});
