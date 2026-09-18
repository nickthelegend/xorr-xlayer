/**
 * Stand up and bootstrap a Solana mainnet fork with real USDC and xStocks (PLAN.md §11).
 *
 * Starts or connects to solana-test-validator, airdrops SOL, funds the dev owner
 * with 25,000 USDC + xStocks (NVDAx), funds the venue vault with liquidity,
 * and writes `.env.fork`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
  delegateKeypair,
  payerKeypair,
  devOwnerKeypair,
  venueVaultKeypair,
} from './keys.js';
import { portArgs, portOf, type ValidatorPorts } from './validator-ports.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8899';
const UPSTREAM_RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';

/*
 * The validator listens where FORK_RPC points, not on a fixed 8899: a fork started for
 * FORK_RPC=http://127.0.0.1:18899 must not collide with another one already on 8899. The faucet
 * and gossip ports move with it — at 8899 they land on the validator's own defaults (9900, 8000) —
 * because a second validator on a fixed faucet or gossip port dies on bind before it serves a slot.
 */
export function derivedPorts(rpcUrl: string): ValidatorPorts {
  const rpc = portOf(rpcUrl);
  return { rpc, faucet: rpc + 1001, gossip: rpc - 899 };
}
export const { rpc: RPC_PORT, faucet: FAUCET_PORT, gossip: GOSSIP_PORT } = derivedPorts(RPC);

export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const NVDAX_MINT = new PublicKey('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh');
export const TSLAX_MINT = new PublicKey('XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB');
export const AAPLX_MINT = new PublicKey('XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp');
export const MSFTX_MINT = new PublicKey('XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX');
export const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

/*
 * The USDC/NVDAx Orca Whirlpool route, as Jupiter returns it today.
 *
 * Cloning the Jupiter program alone buys nothing: `Route` cross-program-invokes the AMM, and the
 * AMM reads its pool, its two vaults, its tick arrays and its oracle. Without these the swap
 * fails on missing accounts and the fill quietly falls back to the venue vault. With them, the
 * fork executes the real route against the pool's real mainnet reserves.
 *
 * These are route-specific. If Jupiter starts quoting a different pool, refresh them with
 * `tools/resolve-jupiter-route.ts`.
 */
export const ROUTE_ACCOUNTS = [
  '6R4r93V5fcMzc13CL2enEepDSYcr4Qx3ptZBDwudTXCo', // Whirlpool USDC/NVDAx
  '5TSHEwRAgHLTYkchrUNiKUL2RvuZgdh3vExbMptWrHoX', // pool USDC vault
  'FaHQ9Ny2U2RkcdapsKVr9pvnt4Mg7n92NdKnvyRzuibH', // pool NVDAx vault (Token-2022)
  '9VJRZWagVaCL2eRNpcV2zYfCSKNzEbdbL9MoBEYnrRv1', // tick array
  'AmmznNxM2zbxxN5wZtorozeakd1LL8GtKUdZYTp7KMfy', // tick array
  'ExnVr11uZZU9Bd8s71CtitGCt86H1T6BARRtvmerZ1tu', // tick array
  'CbTCXA1r93p8p1v8Uhp6Ufoe15FwsmzimWY8AG3TbyxR', // whirlpool oracle
  'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf', // Jupiter event authority
  '2Se6p8VJTcsPWZ2RyaSVCkE5L5ocdFqA5Vj2CEGDZ1rW', // address lookup table the route uses
] as const;

// Real mainnet USDC mint base64 (82 bytes)
const USDC_MINT_BASE64 =
  'AQAAAJj+huiNm+Lqi8HMpIeLKYjCQPUrhCS/tA7Rot3LXhmblCui79AkGwAGAQEAAABicKqKWcWUBbRShshncubNEm6bil06OFNtN/e0FOi2Zw==';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function isValidatorRunning(url = RPC): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Generate genesis account JSON files with payer as mint authority.
 */
export async function prepareGenesisMints(
  fixturesDir: string,
  payer: Keypair,
): Promise<{ usdcPath: string; nvdaxPath: string }> {
  fs.mkdirSync(fixturesDir, { recursive: true });

  // 1. USDC mint: replace bytes 4..36 with payer pubkey
  const usdcBuf = Buffer.from(USDC_MINT_BASE64, 'base64');
  payer.publicKey.toBuffer().copy(usdcBuf, 4);

  const usdcAccount = {
    pubkey: USDC_MINT.toBase58(),
    account: {
      lamports: 1_000_000_000,
      data: [usdcBuf.toString('base64'), 'base64'],
      owner: TOKEN_PROGRAM_ID.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: 82,
    },
  };
  const usdcPath = path.join(fixturesDir, 'usdc-mint.json');
  fs.writeFileSync(usdcPath, JSON.stringify(usdcAccount, null, 2));

  // 2. NVDAx mint: fetch account info from upstream or fallback template
  let nvdaxBuf: Buffer;
  let nvdaxOwner = TOKEN_2022_PROGRAM_ID.toBase58();
  let lamports = 600_000_000;

  try {
    const upstreamRes = await fetch(UPSTREAM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [NVDAX_MINT.toBase58(), { encoding: 'base64' }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    const json = (await upstreamRes.json()) as {
      result?: { value?: { data: [string, string]; owner: string; lamports: number } };
    };
    if (json.result?.value?.data?.[0]) {
      nvdaxBuf = Buffer.from(json.result.value.data[0], 'base64');
      nvdaxOwner = json.result.value.owner;
      lamports = json.result.value.lamports;
    } else {
      throw new Error('No upstream data');
    }
  } catch {
    // Template fallback for Token-2022 8-decimal mint (82 bytes header)
    nvdaxBuf = Buffer.alloc(166);
    nvdaxBuf.writeUInt32LE(1, 0); // mint authority option = 1
    nvdaxBuf.writeBigUInt64LE(100_000_00000000n, 36); // supply
    nvdaxBuf.writeUInt8(8, 44); // decimals = 8
    nvdaxBuf.writeUInt8(1, 45); // isInitialized = 1
  }

  payer.publicKey.toBuffer().copy(nvdaxBuf, 4); // set mintAuthority = payer
  const nvdaxAccount = {
    pubkey: NVDAX_MINT.toBase58(),
    account: {
      lamports,
      data: [nvdaxBuf.toString('base64'), 'base64'],
      owner: nvdaxOwner,
      executable: false,
      rentEpoch: 0,
      space: nvdaxBuf.length,
    },
  };
  const nvdaxPath = path.join(fixturesDir, 'nvdax-mint.json');
  fs.writeFileSync(nvdaxPath, JSON.stringify(nvdaxAccount, null, 2));

  return { usdcPath, nvdaxPath };
}

export interface StartValidatorOptions {
  /** The RPC the caller will talk to. Reused if something already answers there. */
  rpcUrl?: string;
  /**
   * Where to bind. When omitted, `derivedPorts(rpcUrl)`: the well-known layout the README's fork
   * uses. The chain suite passes a block from `allocateValidatorPorts` instead, so parallel runs on
   * one machine never share a port — dynamic range included.
   */
  ports?: ValidatorPorts;
  /** The ledger directory. Defaults to `<fixturesDir>/test-ledger`. */
  ledgerDir?: string;
  /**
   * Called as soon as the process is spawned, before it is ready. A caller that must tear the
   * validator down even when its own setup times out mid-boot needs the handle this early.
   */
  onSpawn?: (child: ChildProcess) => void;
}

/**
 * What the validator said before it died. With --quiet its stdout is empty and the reason — a port
 * already bound, say — is only in the ledger's own log, so read the tail of that too.
 */
function validatorLogs(logPath: string, ledgerDir: string): string {
  const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const ledgerLog = read(path.join(ledgerDir, 'validator.log')).split('\n').slice(-40).join('\n');
  return [read(logPath), ledgerLog].filter(Boolean).join('\n');
}

/**
 * Launch solana-test-validator if nothing already answers at `rpcUrl`.
 */
export async function startValidator(
  fixturesDir: string,
  payer: Keypair,
  opts: StartValidatorOptions = {},
): Promise<ChildProcess | null> {
  const rpcUrl = opts.rpcUrl ?? RPC;
  if (await isValidatorRunning(rpcUrl)) {
    console.log(`Validator is already running on ${rpcUrl}`);
    return null;
  }

  const ports = opts.ports ?? derivedPorts(rpcUrl);
  if (ports.rpc !== portOf(rpcUrl)) {
    throw new Error(`startValidator: RPC port ${ports.rpc} does not match ${rpcUrl}`);
  }

  console.log(`Preparing genesis accounts in ${fixturesDir}...`);
  const { usdcPath, nvdaxPath } = await prepareGenesisMints(fixturesDir, payer);

  const ledgerDir = opts.ledgerDir ?? path.join(fixturesDir, 'test-ledger');
  const logPath = path.join(fixturesDir, 'validator.log');
  const logFd = fs.openSync(logPath, 'w');

  console.log(`Starting solana-test-validator on ${rpcUrl} (ledger ${ledgerDir})...`);

  const child = spawn(
    'solana-test-validator',
    [
      '--ledger',
      ledgerDir,
      ...portArgs(ports),
      '--account',
      USDC_MINT.toBase58(),
      usdcPath,
      '--account',
      NVDAX_MINT.toBase58(),
      nvdaxPath,
      '--clone-upgradeable-program',
      JUPITER_PROGRAM,
      '--clone-upgradeable-program',
      WHIRLPOOL_PROGRAM,
      ...ROUTE_ACCOUNTS.flatMap((a) => ['--clone', a]),
      '--url',
      UPSTREAM_RPC,
      '--reset',
      '--quiet',
    ],
    {
      stdio: ['ignore', logFd, logFd],
      detached: false,
    },
  );
  fs.closeSync(logFd);

  child.on('error', (err) => {
    console.error('Failed to spawn solana-test-validator:', err);
  });

  // A backstop for a parent that exits without tearing the validator down. It cannot cover
  // SIGKILL of the parent, which is why callers still stop it themselves.
  const killOnExit = () => child.kill('SIGKILL');
  process.once('exit', killOnExit);
  child.once('exit', () => process.removeListener('exit', killOnExit));
  opts.onSpawn?.(child);

  // Poll for readiness
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    if (child.exitCode !== null) {
      throw new Error(
        `solana-test-validator exited prematurely with code ${child.exitCode}.\nLogs:\n${validatorLogs(logPath, ledgerDir)}`,
      );
    }
    if (await isValidatorRunning(rpcUrl)) {
      console.log('Validator is ready!');
      return child;
    }
  }

  const logs = validatorLogs(logPath, ledgerDir);
  await stopValidator(child);
  throw new Error(`Timed out waiting for solana-test-validator to boot.\nLogs:\n${logs}`);
}

/**
 * Stop a validator this process started: SIGTERM, then SIGKILL if it has not exited in `graceMs`.
 * Resolves once the process is gone, so the caller can delete its ledger safely.
 */
export async function stopValidator(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  await exited;
  clearTimeout(timer);
}

export async function bootstrapFork(customDevOwner?: string) {
  const payer = payerKeypair();
  const delegate = delegateKeypair();
  const devOwner = customDevOwner ? new PublicKey(customDevOwner) : devOwnerKeypair().publicKey;
  const vault = venueVaultKeypair();

  const fixturesDir = path.resolve(process.cwd(), 'scratch', 'fork-fixtures');
  await startValidator(fixturesDir, payer);

  const conn = new Connection(RPC, 'confirmed');

  console.log('\n--- Airdropping SOL ---');
  for (const [name, pk] of [
    ['Payer', payer.publicKey],
    ['Delegate', delegate.publicKey],
    ['Dev Owner', devOwner],
    ['Venue Vault', vault.publicKey],
  ] as const) {
    const sig = await conn.requestAirdrop(pk, 10 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    const bal = await conn.getBalance(pk);
    console.log(`  ${name} (${pk.toBase58()}): ${bal / LAMPORTS_PER_SOL} SOL`);
  }

  console.log('\n--- Funding Dev Owner & Venue Vault ---');
  // 1. Fund Dev Owner with 25,000 USDC
  const devOwnerUsdcAta = await getOrCreateAssociatedTokenAccount(
    conn,
    payer,
    USDC_MINT,
    devOwner,
    false,
    'confirmed',
    undefined,
    TOKEN_PROGRAM_ID,
  );
  await mintTo(
    conn,
    payer,
    USDC_MINT,
    devOwnerUsdcAta.address,
    payer,
    25_000_000000n, // 25,000 USDC
    [],
    undefined,
    TOKEN_PROGRAM_ID,
  );
  console.log(`  Dev Owner USDC ATA: ${devOwnerUsdcAta.address.toBase58()} -> 25,000 USDC`);

  // 2. Fund Dev Owner with 10 NVDAx
  const devOwnerNvdaxAta = await getOrCreateAssociatedTokenAccount(
    conn,
    payer,
    NVDAX_MINT,
    devOwner,
    false,
    'confirmed',
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  await mintTo(
    conn,
    payer,
    NVDAX_MINT,
    devOwnerNvdaxAta.address,
    payer,
    10_00000000n, // 10 NVDAx
    [],
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  console.log(`  Dev Owner NVDAx ATA: ${devOwnerNvdaxAta.address.toBase58()} -> 10 NVDAx`);

  // 3. Fund Venue Vault with liquidity (100,000 USDC + 1,000 NVDAx)
  const vaultUsdcAta = await getOrCreateAssociatedTokenAccount(
    conn,
    payer,
    USDC_MINT,
    vault.publicKey,
    false,
    'confirmed',
    undefined,
    TOKEN_PROGRAM_ID,
  );
  await mintTo(
    conn,
    payer,
    USDC_MINT,
    vaultUsdcAta.address,
    payer,
    100_000_000000n,
    [],
    undefined,
    TOKEN_PROGRAM_ID,
  );

  const vaultNvdaxAta = await getOrCreateAssociatedTokenAccount(
    conn,
    payer,
    NVDAX_MINT,
    vault.publicKey,
    false,
    'confirmed',
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  await mintTo(
    conn,
    payer,
    NVDAX_MINT,
    vaultNvdaxAta.address,
    payer,
    1_000_00000000n,
    [],
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  console.log(`  Venue Vault USDC ATA: ${vaultUsdcAta.address.toBase58()} -> 100,000 USDC`);
  console.log(`  Venue Vault NVDAx ATA: ${vaultNvdaxAta.address.toBase58()} -> 1,000 NVDAx`);

  // Write .env.fork
  const envContent = [
    '# Generated by fork-bootstrap.ts',
    'XORR_CHAIN=solana-fork',
    `FORK_RPC=${RPC}`,
    `SOLANA_RPC_URL=${RPC}`,
    'EXPO_PUBLIC_XORR_CHAIN=solana-fork',
    `EXPO_PUBLIC_SOLANA_RPC=${RPC}`,
    `DELEGATE_PUBKEY=${delegate.publicKey.toBase58()}`,
    `DEV_OWNER_PUBKEY=${devOwner.toBase58()}`,
    `VENUE_VAULT_PUBKEY=${vault.publicKey.toBase58()}`,
    `USDC_MINT=${USDC_MINT.toBase58()}`,
    `NVDAX_MINT=${NVDAX_MINT.toBase58()}`,
    '',
  ].join('\n');

  fs.writeFileSync('.env.fork', envContent);
  console.log('\nWrote .env.fork successfully.');
  console.log('Fork bootstrap complete! Run tests with:');
  console.log(`  FORK_RPC=${RPC} CHAIN=1 npx vitest run src/solana/fork.chain.test.ts`);
}

/*
 * Run only when THIS file is the entry point. A substring match on 'fork-bootstrap' also fired
 * when infra/solana-fork/fork-bootstrap.ts imported this module, so that wrapper started the
 * bootstrap twice at once and the two validators fought over one set of ports. Compared by real
 * path, because macOS's /tmp is a symlink to /private/tmp.
 */
const isEntryPoint = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  const target = process.argv[2] ?? process.env.OWNER_ADDRESS;
  bootstrapFork(target)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Bootstrap error:', err);
      process.exit(1);
    });
}
