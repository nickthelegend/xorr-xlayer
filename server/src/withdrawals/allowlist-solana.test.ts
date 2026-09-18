import { describe, expect, it } from 'vitest';
import {
  isValidAddress,
  formatAddress,
  COOLING_OFF_HOURS,
  COOLING_OFF_SECONDS,
  utc,
} from './allowlist.js';

describe('withdrawal allowlist Solana support', () => {
  const validSolanaAddress = '7v91N7iZEdMoQg6zJ5pA9oG3eF1n3hXyZ1W2v3u4t5s6';
  const validEvmAddress = '0x95A0108A7Ac6F5e27B75E61feAC587391924e615';

  it('validates both Solana base58 and EVM hex addresses depending on chain', () => {
    expect(isValidAddress(validSolanaAddress, 'solana-fork')).toBe(true);
    expect(isValidAddress(validEvmAddress, 'base-sepolia')).toBe(true);
    expect(isValidAddress('   ' + validSolanaAddress + '   ', 'solana-fork')).toBe(true);

    expect(isValidAddress('0x123', 'solana-fork')).toBe(false);
    expect(isValidAddress('0x123', 'base-sepolia')).toBe(false);
    expect(isValidAddress('invalid!character$', 'solana-fork')).toBe(false);
    expect(isValidAddress('', 'solana-fork')).toBe(false);
  });

  it('formats address preserving Solana base58 case and checksumming EVM', () => {
    expect(formatAddress(validSolanaAddress, 'solana-fork')).toBe(validSolanaAddress);
    expect(formatAddress(validEvmAddress.toLowerCase(), 'base-sepolia')).toBe('0x95a0108a7ac6f5e27b75E61fEac587391924E615');
  });

  it('enforces 24-hour cooling off constant', () => {
    expect(COOLING_OFF_HOURS).toBe(24);
    expect(COOLING_OFF_SECONDS).toBe(86_400);

    const now = 1757800000000;
    const formatted = utc(now);
    expect(formatted).toContain('UTC');
  });
});
