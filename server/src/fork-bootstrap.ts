/**
 * Stand up a demo-ready Base mainnet fork in one command.
 *
 * A fork is the only environment where every piece of this product is real at once — the 1inch
 * router, Aqua, SwapVM, USDC, Aave and the tokenized equities all exist there and none of them
 * exist on Sepolia. But a fresh fork has none of OUR contracts and no spendable balance, so
 * demoing it meant a sequence of manual steps nobody remembers.
 *
 * This deploys the three contracts, funds a wallet with real USDC taken from a real holder, and
 * writes the addresses to `.env.fork`. Nothing here is a mock: the USDC is Circle's, moved by
 * impersonating an account that genuinely holds it, which is what a fork is for.
 *
 * Run:  npx tsx server/src/fork-bootstrap.ts [walletAddressToFund]
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  erc20Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { base } from 'viem/chains';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const AQUA: Address = '0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a';
const SWAP_VM: Address = '0x111111338c5091E8440b67B168bAe16a668AC0De';
/** Aave v3's aUSDC reserve on Base — a real contract holding tens of millions of real USDC. */
const WHALE: Address = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';

const chain = { ...base, rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });

async function anvil(method: string, params: unknown[]) {
  const r = (await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((x) => x.json())) as { result?: unknown; error?: { message: string } };
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}

async function artifact(name: string): Promise<{ abi: unknown[]; bytecode: Hex }> {
  const file = new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url);
  const json = JSON.parse(await fs.readFile(file, 'utf8')) as {
    abi: unknown[];
    bytecode: { object: Hex };
  };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function main() {
  /*
   * The wallet to fund, from either place.
   *
   * It was `argv[2]` only. Rebuilding the fork for real, the natural invocation — with every other
   * setting already in the environment — silently skipped funding entirely, and the run finished
   * looking successful: contracts deployed, delegate funded, "wrote .env.fork". The user wallet
   * had zero USDC and zero ETH, which surfaces later as a trade that cannot pay for itself.
   *
   * `OWNER_ADDRESS` is what the rest of the fork tooling already reads, so it is the name someone
   * will already have set.
   */
  const fundTarget = (process.argv[2] ?? process.env.OWNER_ADDRESS) as Address | undefined;
  if (!fundTarget) {
    console.log(
      'No wallet to fund. Pass one as an argument or set OWNER_ADDRESS; the contracts will still\n' +
        'deploy, but nothing will be able to trade on this fork.\n',
    );
  }

  const block = await pub.getBlockNumber();
  const id = await pub.getChainId();
  if (id !== base.id) {
    throw new Error(`${RPC} is chain ${id}, not Base (${base.id}). Fork Base mainnet, not Sepolia.`);
  }
  console.log(`fork ${RPC}  chain ${id}  block ${block}\n`);

  // A fresh key per bootstrap. Never a well-known test key: anvil's default accounts have public
  // private keys and sweeper bots drain anything sent to them within seconds, including on chains
  // people assume nobody watches.
  const deployer = privateKeyToAccount(generatePrivateKey());
  await anvil('anvil_setBalance', [deployer.address, '0x8AC7230489E80000']); // 10 ETH
  const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });

  const delegationArt = await artifact('XorrDelegation');
  const delegationHash = await wallet.deployContract({
    abi: delegationArt.abi as never,
    bytecode: delegationArt.bytecode,
    // The settlement token: what the daily cap is counted in, and what a close may not sell.
    args: [USDC] as never,
  });
  const delegation = (await pub.waitForTransactionReceipt({ hash: delegationHash }))
    .contractAddress as Address;
  console.log(`XorrDelegation   ${delegation}`);

  const bookArt = await artifact('XorrAquaBook');
  const bookHash = await wallet.deployContract({
    abi: bookArt.abi as never,
    bytecode: bookArt.bytecode,
    args: [AQUA, delegation],
  });
  const book = (await pub.waitForTransactionReceipt({ hash: bookHash })).contractAddress as Address;
  console.log(`XorrAquaBook     ${book}`);

  const vmArt = await artifact('XorrSwapVMBook');
  const vmHash = await wallet.deployContract({
    abi: vmArt.abi as never,
    bytecode: vmArt.bytecode,
    args: [AQUA, SWAP_VM, delegation],
  });
  const swapVMBook = (await pub.waitForTransactionReceipt({ hash: vmHash }))
    .contractAddress as Address;
  console.log(`XorrSwapVMBook   ${swapVMBook}`);

  /*
   * The bot's key must hold gas on this chain or every scheduled run dies at signing — and the
   * error it produces ("exceeds the balance of the account") reads as the USER being short, which
   * sends you looking in the wrong place entirely.
   *
   * The key is normally a file, not an env var, so ask the executor's own client for the address
   * rather than re-deriving it here and risking the two disagreeing.
   */
  const { delegatePublicKey } = await import('./evm/client.js').then(async (m) => ({
    delegatePublicKey: m.delegateAccount.address,
  }));
  await anvil('anvil_setBalance', [delegatePublicKey, '0x8AC7230489E80000']);
  console.log(`delegate funded  ${delegatePublicKey}`);

  /*
   * And the delegate the deployed executor signs with (PLAN.md 3.2).
   *
   * `delegateAccount` is this machine's key. The executor on the fork signs with its own, which only the host
   * holds; the runbook funded that one by hand as a separate step, and a rebuild that skipped it left every
   * run dying at signing.
   */
  const deployedDelegate = process.env.XORR_DELEGATE_ADDRESS as Address | undefined;
  if (deployedDelegate && deployedDelegate.toLowerCase() !== delegatePublicKey.toLowerCase()) {
    await anvil('anvil_setBalance', [deployedDelegate, '0x8AC7230489E80000']);
    console.log(`delegate funded  ${deployedDelegate} (the deployed executor's)`);
  }

  if (fundTarget) {
    const amount = parseUnits('25000', 6);
    const held = await pub.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [WHALE],
    });
    if (held < amount) throw new Error(`whale holds only ${formatUnits(held, 6)} USDC`);

    await anvil('anvil_impersonateAccount', [WHALE]);
    await anvil('anvil_setBalance', [WHALE, '0xDE0B6B3A7640000']);
    const whaleWallet = createWalletClient({ account: WHALE, chain, transport: http(RPC) });
    const h = await whaleWallet.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [fundTarget, amount],
    });
    await pub.waitForTransactionReceipt({ hash: h });
    await anvil('anvil_stopImpersonatingAccount', [WHALE]);

    await anvil('anvil_setBalance', [fundTarget, '0x8AC7230489E80000']);
    const bal = await pub.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [fundTarget],
    });
    console.log(`\nfunded ${fundTarget}\n  ${formatUnits(bal, 6)} USDC + 10 ETH for gas`);
  }

  /*
   * The audit anchor, and liquidity in both books (PLAN.md 3.2).
   *
   * A rebuilt fork had no `XorrAuditAnchor`, so nothing on it could be anchored and `/verify` skipped the
   * check; and no maker had shipped to either book, so every fill fell through to the aggregator and the Aqua
   * and SwapVM paths went unexercised until someone ran `live-aqua.ts` and `live-swapvm.ts` by hand.
   */
  const anchorArt = await artifact('XorrAuditAnchor');
  const anchorHash = await wallet.deployContract({ abi: anchorArt.abi as never, bytecode: anchorArt.bytecode } as never);
  const anchor = (await pub.waitForTransactionReceipt({ hash: anchorHash })).contractAddress as Address;
  console.log(`XorrAuditAnchor  ${anchor}`);

  const { shipAquaBook, shipSwapVmProgram } = await import('./fork/makers.js');
  const { priceOf } = await import('./market/prices.js');
  const { quote } = await import('./venues/oneinch.js');
  const aquaBook = await shipAquaBook({ rpc: RPC, book, priceUsd: await priceOf('WETH') });
  console.log(`Aqua book        ${formatUnits(aquaBook.weth, 18)} WETH / ${formatUnits(aquaBook.usdc, 6)} USDC, maker ${aquaBook.maker}`);
  const reference = await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 50 });
  const program = await shipSwapVmProgram({ rpc: RPC, book: swapVMBook, wethPerUsdc: reference.outAmount / 50 });
  console.log(
    `SwapVM program   ${program.bytes} bytes, ${formatUnits(program.usdc, 6)} USDC / ${formatUnits(program.weth, 18)} WETH, maker ${program.maker}`,
  );

  // Where the addresses go. A second file keeps a local rehearsal from overwriting the deployed fork's record.
  const envPath = path.resolve(process.cwd(), process.env.FORK_ENV_FILE ?? '.env.fork');
  await fs.writeFile(
    envPath,
    [
      '# Generated by server/src/fork-bootstrap.ts. Regenerate whenever the fork restarts —',
      '# a fresh anvil has none of these contracts.',
      'XORR_CHAIN=base-fork',
      `FORK_RPC=${RPC}`,
      // The APP has to sign on the same chain the executor settles on. Without these the Privy
      // provider defaults to Base Sepolia and every user-signed transaction — the grant, the
      // approvals, a withdrawal — goes to a chain nobody is trading on.
      'EXPO_PUBLIC_XORR_CHAIN=base-fork',
      `EXPO_PUBLIC_CHAIN_RPC=${RPC}`,
      `DELEGATION_ADDRESS=${delegation}`,
      `EXPO_PUBLIC_DELEGATION_ADDRESS=${delegation}`,
      `AQUA_BOOK_ADDRESS=${book}`,
      `SWAPVM_BOOK_ADDRESS=${swapVMBook}`,
      `ANCHOR_ADDRESS=${anchor}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  console.log(`\nwrote ${envPath}`);
  console.log('\nstart the executor against it:');
  console.log('  set -a && . .env && . .env.fork && set +a && npx tsx server/src/index.ts');
}

await main();
