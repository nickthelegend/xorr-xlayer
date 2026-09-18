/**
 * Ports for a solana-test-validator that this process starts itself.
 *
 * Several checkouts of this repo run their suites on one machine at once. With the validator's
 * defaults — RPC 8899, websocket 8900, faucet 9900 — the second run to start either failed to bind
 * or, worse, found the first run's validator already answering on 8899 and ran its proofs against
 * that ledger: a proof timed out or read another run's balances, and "passed on re-run" once the
 * other validator went away. So a validator started for a run gets ports nobody else holds.
 *
 * This module imports nothing from the Solana layer on purpose: the chain suite calls it before the
 * modules that read `FORK_RPC` at import time are loaded.
 */
import * as net from 'node:net';
import * as dgram from 'node:dgram';

/** The narrowest `--dynamic-port-range` agave 3.x accepts is 25 ports; leave some headroom. */
export const DYNAMIC_RANGE_WIDTH = 32;

export interface ValidatorPorts {
  /** `--rpc-port`. The validator also binds `rpc + 1` for the websocket. */
  rpc: number;
  faucet: number;
  gossip: number;
  /**
   * `--dynamic-port-range`, inclusive: TPU, TVU, repair and the rest. Omitted, the validator picks
   * from its own default range.
   */
  dynamicRange?: [number, number];
}

function tcpFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function udpFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', () => {
      socket.close();
      resolve(false);
    });
    socket.bind({ port, address: '0.0.0.0', exclusive: true }, () => socket.close(() => resolve(true)));
  });
}

/** Free for both TCP and UDP right now. The validator binds both on most of its ports. */
export async function isPortFree(port: number): Promise<boolean> {
  return (await tcpFree(port)) && (await udpFree(port));
}

/**
 * A contiguous block of free ports: RPC, websocket, faucet, gossip, then the dynamic range.
 *
 * The block starts at a random offset so two runs allocating at the same moment are unlikely to
 * probe the same ports; between the probe and the validator's bind there is still a window, and a
 * run that loses it fails loudly at boot rather than attaching to someone else's ledger.
 */
export async function allocateValidatorPorts(): Promise<ValidatorPorts> {
  const need = 4 + DYNAMIC_RANGE_WIDTH;
  const LOW = 20_000;
  const HIGH = 60_000;
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = LOW + Math.floor(Math.random() * (HIGH - LOW - need));
    let free = true;
    // Every port in the block, the websocket's `rpc + 1` included, must be free.
    for (let p = base; p < base + need && free; p++) free = await isPortFree(p);
    if (!free) continue;
    return {
      rpc: base,
      faucet: base + 2,
      gossip: base + 3,
      dynamicRange: [base + 4, base + 4 + DYNAMIC_RANGE_WIDTH - 1],
    };
  }
  throw new Error('Could not find a free block of ports for solana-test-validator.');
}

/** The `solana-test-validator` arguments that place it on `ports`. */
export function portArgs(ports: ValidatorPorts): string[] {
  return [
    '--rpc-port',
    String(ports.rpc),
    '--faucet-port',
    String(ports.faucet),
    '--gossip-port',
    String(ports.gossip),
    ...(ports.dynamicRange ? ['--dynamic-port-range', `${ports.dynamicRange[0]}-${ports.dynamicRange[1]}`] : []),
  ];
}

/** The port an RPC URL names, with the scheme's default when it names none. */
export function portOf(rpcUrl: string): number {
  const url = new URL(rpcUrl);
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}
