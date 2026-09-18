/**
 * A formatter called from render must not be able to take a screen down.
 *
 * `shortAddress` took `string` and called `.trim()` on it. An executor older than a field it was
 * asked to render sent `undefined`, and `/sponsors` went straight to the error boundary — the whole
 * screen, for one missing address, because of a rolling deploy. That is not a hypothetical
 * condition; it is what deploying looks like.
 *
 * The contract these pin: absent formats as an em dash, and short input is returned rather than
 * mangled into an ellipsis that identifies nothing.
 */
import { describe, expect, it } from 'vitest';
import { shortAddress } from './index';

describe('shortAddress', () => {
  it('shortens a real address to something checkable at both ends', () => {
    expect(shortAddress('0xb14CF3D0b5269aCDE52322218adb6d5C1daE0a4e')).toBe('0xb14C…0a4e');
  });

  it('formats absence as an em dash rather than throwing', () => {
    // The three ways a caller can have nothing, all from real API shapes. An em dash, the app's
    // "not known": the minus sign it used to be read as a negative number beside an address.
    expect(shortAddress(undefined)).toBe('—');
    expect(shortAddress(null)).toBe('—');
    expect(shortAddress('')).toBe('—');
  });

  it('returns anything too short to shorten as-is', () => {
    // An ellipsis through a short string identifies nothing, and hiding a malformed value behind
    // one makes a bug upstream look deliberate.
    expect(shortAddress('0x1234')).toBe('0x1234');
  });

  it('keeps six leading characters, so two addresses are actually distinguishable', () => {
    const a = shortAddress('0xaaaa1111111111111111111111111111111111bbbb');
    const b = shortAddress('0xaaab1111111111111111111111111111111111bbbb');
    expect(a).not.toBe(b);
  });
});
