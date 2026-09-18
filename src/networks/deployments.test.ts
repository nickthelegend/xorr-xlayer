/**
 * The deployment list is the one place a chain is added, so what every row must carry is pinned here.
 *
 * The list itself is empty until an X Layer executor is deployed (no address is written down before it answers), so the
 * matching rules are pinned against a list of example rows. The hosts are `.example` on purpose: they name nothing.
 */
import { describe, expect, it } from 'vitest';
import { DEPLOYMENTS, deploymentFor, thisDeployment, type Deployment } from './deployments';

const EXAMPLES: readonly Deployment[] = [
  {
    key: 'xlayer-testnet',
    name: 'X Layer testnet',
    chainId: 1952,
    api: 'https://executor-testnet.example',
    explorer: 'https://explorer-testnet.example',
    test: true,
  },
  {
    key: 'xlayer-fork',
    name: 'X Layer fork',
    chainId: 196,
    api: 'https://executor-fork.example',
    explorer: null,
    test: true,
  },
];

describe('DEPLOYMENTS', () => {
  it('names each network once, with an https executor, a chain id and an explorer that is https or none', () => {
    for (const list of [DEPLOYMENTS, EXAMPLES]) {
      expect(new Set(list.map((d) => d.key)).size).toBe(list.length);
      for (const d of list) {
        expect(d.api, d.key).toMatch(/^https:\/\//);
        expect(Number.isInteger(d.chainId) && d.chainId > 0, d.key).toBe(true);
        expect(d.explorer === null || /^https:\/\//.test(d.explorer), d.key).toBe(true);
        expect(d.name.trim().length, d.key).toBeGreaterThan(0);
      }
    }
  });

  it('names only X Layer chains — mainnet 196 and its fork, testnet 1952', () => {
    for (const d of DEPLOYMENTS) expect([196, 1952], d.key).toContain(d.chainId);
  });
});

describe('thisDeployment', () => {
  it('matches the executor this build talks to, with or without a trailing slash', () => {
    expect(thisDeployment('https://executor-testnet.example', EXAMPLES)?.key).toBe('xlayer-testnet');
    expect(thisDeployment('https://executor-fork.example/', EXAMPLES)?.key).toBe('xlayer-fork');
  });

  it('names none for an executor no deployment serves, rather than guessing from the chain', () => {
    expect(thisDeployment('http://localhost:8788', EXAMPLES)).toBeUndefined();
    expect(thisDeployment('http://localhost:8788')).toBeUndefined();
  });
});

describe('deploymentFor', () => {
  it('finds a deployment by chain key, and nothing for a key or no key', () => {
    // A fork of X Layer IS X Layer: it answers mainnet's own id.
    expect(deploymentFor('xlayer-fork', EXAMPLES)?.chainId).toBe(196);
    expect(deploymentFor('base-fork', EXAMPLES)).toBeUndefined();
    expect(deploymentFor(undefined, EXAMPLES)).toBeUndefined();
  });
});
