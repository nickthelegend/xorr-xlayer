/**
 * The deployment list is the one place a chain is added, so what every row must carry is pinned here.
 */
import { describe, expect, it } from 'vitest';
import { DEPLOYMENTS, deploymentFor, thisDeployment } from './deployments';

describe('DEPLOYMENTS', () => {
  it('names each network once, with an https executor, a chain id and an explorer that is https or none', () => {
    expect(new Set(DEPLOYMENTS.map((d) => d.key)).size).toBe(DEPLOYMENTS.length);
    for (const d of DEPLOYMENTS) {
      expect(d.api, d.key).toMatch(/^https:\/\//);
      expect(Number.isInteger(d.chainId) && d.chainId > 0, d.key).toBe(true);
      expect(d.explorer === null || /^https:\/\//.test(d.explorer), d.key).toBe(true);
      expect(d.name.trim().length, d.key).toBeGreaterThan(0);
    }
  });
});

describe('thisDeployment', () => {
  it('matches the executor this build talks to, with or without a trailing slash', () => {
    expect(thisDeployment('https://api.xorr.finance')?.key).toBe('base-sepolia');
    expect(thisDeployment('https://executor-fork-production.up.railway.app/')?.key).toBe('base-fork');
  });

  it('names none for an executor no deployment serves, rather than guessing from the chain', () => {
    expect(thisDeployment('http://localhost:8788')).toBeUndefined();
  });
});

describe('deploymentFor', () => {
  it('finds a deployment by chain key, and nothing for a key or no key', () => {
    expect(deploymentFor('base-fork')?.chainId).toBe(8453);
    expect(deploymentFor('arbitrum')).toBeUndefined();
    expect(deploymentFor(undefined)).toBeUndefined();
  });
});
