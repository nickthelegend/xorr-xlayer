/**
 * LIVE: 1inch's Balance and Token APIs on Base, with the real key (PLAN.md 3.10). Read-only.
 * Run: LIVE=1 npx vitest run src/venues/balance.live.test.ts
 *
 * The wallet read is the WETH predeploy. Every wrapped ether on Base is native ETH held by that contract, and tokens
 * sent to it by mistake cannot be taken back out, so it holds native ETH and a spread of ERC-20s, and always will.
 */
import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { TOKENS, oneinchApi } from './oneinch.js';
import { holdingsOnBase, tokenInfo } from './balance.js';

const WETH_PREDEPLOY = '0x4200000000000000000000000000000000000006';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
/** Not a token contract, so there is nothing for the Token API to describe. */
const NOT_A_TOKEN = '0x000000000000000000000000000000000000dead';

describe.skipIf(!process.env.LIVE)('1inch Balance and Token APIs, Base', () => {
  it('the Balance API answers a raw balance for every token on its list, keyed by lowercase address, with native ETH under 0xeeee', async () => {
    const body = await oneinchApi<Record<string, unknown>>(`/balance/v1.2/8453/balances/${WETH_PREDEPLOY}`);

    expect(Array.isArray(body)).toBe(false);
    const entries = Object.entries(body);
    // A list, not the wallet's holdings: zeros are rows too.
    expect(entries.length).toBeGreaterThan(50);
    expect(entries.some(([, raw]) => raw === '0')).toBe(true);
    for (const [address, raw] of entries) {
      expect(address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(raw).toEqual(expect.stringMatching(/^\d+$/));
    }
    expect(BigInt(body[NATIVE] as string)).toBeGreaterThan(0n);
    // Every token this app trades is on the list, so none of them can be missed on Base.
    for (const [symbol, t] of Object.entries(TOKENS)) {
      expect(Object.keys(body), `${symbol} is on 1inch's balance list`).toContain(t.address.toLowerCase());
    }
  }, 60_000);

  it('the Token API describes each address it knows by lowercase address, and leaves out one it does not', async () => {
    const body = await oneinchApi<Record<string, Record<string, unknown>>>(
      `/token/v1.2/8453/custom?addresses=${[NATIVE, USDC, NOT_A_TOKEN].join(',')}`,
    );

    expect(Object.keys(body).sort()).toEqual([NATIVE, USDC].sort());
    expect(body[USDC]).toMatchObject({
      address: USDC,
      symbol: 'USDC',
      name: expect.any(String),
      decimals: 6,
      logoURI: expect.stringMatching(/^https:\/\//),
    });
    expect(body[NATIVE]).toMatchObject({ address: NATIVE, symbol: 'ETH', decimals: 18 });
  }, 60_000);

  it("1inch's decimals agree with the registry's for every token the app trades", async () => {
    const info = await tokenInfo(Object.values(TOKENS).map((t) => t.address));
    for (const [symbol, t] of Object.entries(TOKENS)) {
      expect(info.get(t.address.toLowerCase())?.decimals, symbol).toBe(t.decimals);
    }
  }, 60_000);

  it('holdingsOnBase lists a real wallet: native ETH and ERC-20s, each sized, named and given its feed', async () => {
    const { tokens, undescribed } = await holdingsOnBase(WETH_PREDEPLOY);

    expect(undescribed).toEqual([]);
    expect(tokens.length).toBeGreaterThan(1);
    for (const t of tokens) {
      expect(t.address).toBe(getAddress(t.address));
      expect(t.symbol.trim().length).toBeGreaterThan(0);
      expect(Number.isInteger(t.decimals)).toBe(true);
      expect(Number.isFinite(t.units) && t.units > 0).toBe(true);
    }
    const eth = tokens.find((t) => t.native);
    expect(eth).toMatchObject({
      symbol: 'ETH',
      address: getAddress(NATIVE),
      decimals: 18,
      feed: 'ETH',
      logo: expect.stringMatching(/^https:\/\//),
    });
    // Every wrapped ether on Base is held here.
    expect(eth!.units).toBeGreaterThan(1_000);
    // WETH sent to the WETH contract: a registry token, under the registry's name and priced as itself.
    expect(tokens.find((t) => t.address === getAddress(WETH_PREDEPLOY))).toMatchObject({ symbol: 'WETH', feed: 'WETH' });
  }, 60_000);

  it('a wallet that has never held anything is an empty list, not an error', async () => {
    const fresh = privateKeyToAccount(generatePrivateKey()).address;
    expect(await holdingsOnBase(fresh)).toEqual({ tokens: [], undescribed: [] });
  }, 60_000);
});
