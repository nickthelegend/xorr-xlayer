/**
 * The address a request names must be one Privy says belongs to the caller.
 *
 * The binding itself — never moving a row between users — is proven against a real Postgres in
 * `walletBinding.live.test.ts`; this pins the matching every call starts from.
 */
import { describe, expect, it } from 'vitest';
import { findLinkedWallet } from './walletBinding.js';

const EMBEDDED = { address: '0x95A0b368588713011a15f4b1041423f31B08e615', embedded: true };
const EXTENSION = { address: '0x364d7Bbc139541e0e37450D527ae154B5C292581', embedded: false };

describe('findLinkedWallet', () => {
  it("finds the caller's wallet whatever case the request used", () => {
    expect(findLinkedWallet([EMBEDDED], '0x95a0b368588713011a15f4b1041423f31b08e615')).toBe(EMBEDDED);
    expect(findLinkedWallet([EMBEDDED], '0X95A0B368588713011A15F4B1041423F31B08E615'.replace('0X', '0x'))).toBe(
      EMBEDDED,
    );
  });

  it('finds a linked wallet that is not the embedded one', () => {
    expect(findLinkedWallet([EMBEDDED, EXTENSION], EXTENSION.address)?.embedded).toBe(false);
  });

  it("refuses an address that is not on the caller's account — the takeover request", () => {
    expect(findLinkedWallet([EXTENSION], EMBEDDED.address)).toBeUndefined();
    expect(findLinkedWallet([], EMBEDDED.address)).toBeUndefined();
  });

  it('refuses something that is not an address at all', () => {
    expect(findLinkedWallet([EMBEDDED], '0x95A0')).toBeUndefined();
    expect(findLinkedWallet([EMBEDDED], "0x95A0b368588713011a15f4b1041423f31B08e615'; --")).toBeUndefined();
  });
});
