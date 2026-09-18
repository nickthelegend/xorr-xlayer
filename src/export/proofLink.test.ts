/**
 * The link to a wallet's checks (FEATURES.md #22): which owners a link may name, where it may point, and what a closed
 * share sheet means. The platform half — the sheet and the clipboard — is `shareLink.ts`, and decides nothing.
 */
import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { linkOrigin, linkedOwner, proofLink, shareDismissed } from './proofLink';

const LOWER = '0x4b3a2f1e0d9c8b7a695847362514039281706f5e';
const CHECKSUMMED = getAddress(LOWER);
/** One letter's case flipped: the checksum no longer holds, and the executor answers 400. */
const MISCASED = CHECKSUMMED.replace(/[a-f]/, (c) => c.toUpperCase());
const ORIGIN = 'https://app.example.org';

describe('the owner a link names', () => {
  it('is an address the executor would take', () => {
    expect(linkedOwner(LOWER)).toBe(LOWER);
    expect(linkedOwner(CHECKSUMMED)).toBe(CHECKSUMMED);
    expect(linkedOwner(`  ${CHECKSUMMED}\n`)).toBe(CHECKSUMMED);
  });

  it('is nobody, silently, when the link names anything else', () => {
    expect(MISCASED).not.toBe(CHECKSUMMED);
    for (const raw of [undefined, '', 'alice.base.eth', '0x123', MISCASED, `${LOWER}00`, [LOWER, LOWER]]) {
      expect(linkedOwner(raw), String(raw)).toBeUndefined();
    }
  });
});

describe('where a link points', () => {
  it('is the page’s own origin in a browser', () => {
    expect(linkOrigin('web', ORIGIN)).toBe(ORIGIN);
    expect(linkOrigin('web', 'http://localhost:8081')).toBe('http://localhost:8081');
  });

  it('is nowhere on a phone, or on a page with no real origin', () => {
    expect(linkOrigin('ios', ORIGIN)).toBeUndefined();
    expect(linkOrigin('android', undefined)).toBeUndefined();
    expect(linkOrigin('web', undefined)).toBeUndefined();
    expect(linkOrigin('web', 'null')).toBeUndefined();
    expect(linkOrigin('web', 'file://')).toBeUndefined();
  });
});

describe('the link', () => {
  it('opens either screen straight to that wallet', () => {
    expect(proofLink(ORIGIN, '/judge', CHECKSUMMED)).toBe(`${ORIGIN}/judge?owner=${CHECKSUMMED}`);
    expect(proofLink(ORIGIN, '/verify', LOWER)).toBe(`${ORIGIN}/verify?owner=${LOWER}`);
  });

  it('reads back as the owner it was made for', () => {
    const link = new URL(proofLink(ORIGIN, '/judge', CHECKSUMMED)!);
    expect(link.pathname).toBe('/judge');
    expect(linkedOwner(link.searchParams.get('owner') ?? undefined)).toBe(CHECKSUMMED);
  });

  it('is not made without an origin or a wallet', () => {
    expect(proofLink(undefined, '/judge', LOWER)).toBeUndefined();
    expect(proofLink(ORIGIN, '/judge', undefined)).toBeUndefined();
    expect(proofLink(ORIGIN, '/judge', '')).toBeUndefined();
    expect(proofLink(ORIGIN, '/verify', '0x123')).toBeUndefined();
  });
});

describe('a share sheet that closed', () => {
  it('is a choice, and only a refusal falls back to the clipboard', () => {
    expect(shareDismissed(Object.assign(new Error('Share canceled'), { name: 'AbortError' }))).toBe(true);
    expect(shareDismissed(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }))).toBe(false);
    expect(shareDismissed(new Error('anything else'))).toBe(false);
    expect(shareDismissed(undefined)).toBe(false);
  });
});
