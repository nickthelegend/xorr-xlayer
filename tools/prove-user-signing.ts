/**
 * PLAN.md 4.1 — a Privy wallet signs, and the fork takes it, through the app's own signing path.
 *
 * `src/wallet/userSigning.ts` is what the grant, the approvals and a withdrawal go through on a fork build: the nonce, gas
 * and fees read from the fork, `eth_signTransaction`, the signed bytes checked against what was asked, and the raw
 * transaction broadcast to the fork. This runs that code with a Privy wallet on the other end — a server wallet driven
 * through Privy's wallet RPC API, since the embedded wallet in the app needs a person to sign in — against a fork:
 *
 *   1. an approval to the delegation, signed by Privy, mined on the fork, and the allowance read back;
 *   2. with `--transfer <address>`, a USDC transfer out of that wallet — a user-signed withdrawal on chain (4.9) — after
 *      moving it fork USDC from the fork-only reserve (server/src/fork/anvil.ts FORK_USDC_RESERVE, given its balance
 *      with `dealErc20`) by impersonation, as the fork faucet and bootstrap do. X Layer has no well-known USDC holder to
 *      borrow from, and taking USDC out of a Uniswap pool would move the prices the demo trades against.
 *
 *   set -a; . ./.env; . server/.env.fork; set +a
 *   PRIVY_PROOF_WALLET_ID=<reuse one> server/node_modules/.bin/tsx tools/prove-user-signing.ts [--transfer 0x…]
 *
 * FORK_RPC is an anvil fork of X Layer mainnet (chain 196) — a local one, or the hosted fork when that is deliberate: this
 * SENDS transactions to it. DELEGATION_ADDRESS is that fork's delegation contract. Refuses any node that is not anvil, or
 * that is not a copy of X Layer mainnet. A wallet it creates is unowned, has no policy, and holds fork funds only; its id is
 * printed so the next run can reuse it. What this cannot show is Privy's embedded-wallet sheet in a browser accepting
 * `eth_signTransaction`: that takes a person signed in.
 */
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddressEqual,
  parseEventLogs,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { xLayer } from 'viem/chains';
import { FORK_USDC_RESERVE as RESERVE, dealErc20 } from '../server/src/fork/anvil';
import { sendAsUser, type WalletProvider } from '../src/wallet/userSigning';

/** Circle's native USDC on X Layer mainnet (server/src/evm/chains.ts) — what a fork of it holds too. */
const USDC: Address = '0xB6CEceAB302E2E4948951eE7843FC24E92933061';

let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

type Privy = <T>(method: string, path: string, body?: unknown) => Promise<{ status: number; body: T }>;

function privyApi(appId: string, secret: string): Privy {
  return async (method, path, body) => {
    const res = await fetch(`https://api.privy.io/v1${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`,
        'privy-app-id': appId,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

/**
 * Privy's wallet RPC API as the provider `sendAsUser` talks to. It translates `eth_signTransaction` into Privy's field
 * names and nothing else. A server wallet has no current network, so `eth_chainId` answers the network it was last
 * switched to: the chain check (4.6) is proven by `userSigning.test.ts`, not here.
 */
function privyWallet(privy: Privy, walletId: string): WalletProvider {
  let chainId: number = xLayer.id;
  return {
    async request({ method, params }) {
      switch (method) {
        case 'wallet_switchEthereumChain':
          chainId = Number(BigInt((params?.[0] as { chainId: string }).chainId));
          return null;
        case 'eth_chainId':
          return toHex(chainId);
        case 'eth_signTransaction': {
          const t = params?.[0] as Record<string, string | number>;
          const res = await privy<{ data?: { signed_transaction?: Hex } }>('POST', `/wallets/${walletId}/rpc`, {
            method: 'eth_signTransaction',
            params: {
              transaction: {
                to: t.to,
                data: t.data,
                value: t.value,
                chain_id: t.chainId,
                type: t.type,
                nonce: t.nonce,
                gas_limit: t.gasLimit,
                max_fee_per_gas: t.maxFeePerGas,
                max_priority_fee_per_gas: t.maxPriorityFeePerGas,
              },
            },
          });
          const raw = res.body.data?.signed_transaction;
          if (!raw) throw new Error(`Privy did not sign: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
          return raw;
        }
        default:
          throw new Error(`${method} is not something this proof's wallet answers`);
      }
    },
  };
}

async function main(): Promise<void> {
  const appId = process.env.PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  const rpc = process.env.FORK_RPC;
  const delegation = process.env.DELEGATION_ADDRESS as Address | undefined;
  if (!appId || !secret || !rpc || !delegation) {
    throw new Error('PRIVY_APP_ID, PRIVY_APP_SECRET, FORK_RPC and DELEGATION_ADDRESS are required');
  }
  const transferAt = process.argv.indexOf('--transfer');
  const transferTo = transferAt === -1 ? undefined : getAddress(process.argv[transferAt + 1] ?? '');
  const privy = privyApi(appId, secret);

  // A fork of X Layer IS X Layer: its chain wholesale with the RPC replaced (src/chain.ts withRpc), so Multicall3 is known.
  const chain = { ...xLayer, rpcUrls: { default: { http: [rpc] }, public: { http: [rpc] } } };
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const anvil = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });

  const node = String(await pub.request({ method: 'web3_clientVersion' }));
  if (!node.startsWith('anvil')) throw new Error(`refusing: the node is ${node}, not anvil`);
  const forkedChain = await pub.getChainId();
  if (forkedChain !== xLayer.id) throw new Error(`refusing: the node is chain ${forkedChain}, not a fork of X Layer mainnet (${xLayer.id})`);
  console.log(`fork ${new URL(rpc).host} · ${node} · chain ${forkedChain} · block ${await pub.getBlockNumber()}`);

  let walletId = process.env.PRIVY_PROOF_WALLET_ID;
  let from: Address;
  if (walletId) {
    const found = await privy<{ address?: string }>('GET', `/wallets/${walletId}`);
    if (!found.body.address) throw new Error(`Privy has no wallet ${walletId}: ${found.status}`);
    from = getAddress(found.body.address);
    console.log(`Privy wallet ${walletId} · ${from} (reused)`);
  } else {
    const created = await privy<{ id: string; address: string }>('POST', '/wallets', { chain_type: 'ethereum' });
    if (created.status >= 300) throw new Error(`creating a Privy wallet → ${created.status}`);
    walletId = created.body.id;
    from = getAddress(created.body.address);
    console.log(`Privy wallet ${walletId} · ${from} (created; set PRIVY_PROOF_WALLET_ID to reuse it)`);
  }
  await anvil('anvil_setBalance', [from, toHex(10n ** 17n)]);
  const signer = { provider: privyWallet(privy, walletId), from, chain, chainAccess: pub, signOnly: true };

  console.log('1. an approval, signed by Privy through sendAsUser, broadcast to the fork by the app');
  const allowance = () => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'allowance', args: [from, delegation] });
  const before = await allowance();
  const amount = before + 1_000_000n;
  const approveHash = await sendAsUser(
    signer,
    USDC,
    encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [delegation, amount] }),
  );
  const approved = await pub.waitForTransactionReceipt({ hash: approveHash });
  const after = await allowance();
  console.log(`  ${approveHash} · block ${approved.blockNumber} · gas ${approved.gasUsed}`);
  check(approved.status === 'success', 'mined on the fork');
  check(isAddressEqual(approved.from, from), `sent from the Privy wallet ${from}`);
  check(after === amount, `allowance to the delegation ${before} → ${after}`);

  if (transferTo) {
    console.log(`2. a withdrawal: 5 USDC from the Privy wallet to ${transferTo}`);
    const five = 5_000_000n;
    const usdcOf = (a: Address) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
    if ((await usdcOf(from)) < five) {
      // The reserve holds exactly what is written into USDC's storage for it; the transfer out is an ordinary one.
      if ((await usdcOf(RESERVE)) < 25_000_000n) await dealErc20({ rpc, token: USDC, holder: RESERVE, amount: 1_000_000_000_000n });
      await anvil('anvil_impersonateAccount', [RESERVE]);
      try {
        await anvil('anvil_setBalance', [RESERVE, toHex(10n ** 17n)]);
        const funding = (await pub.request({
          method: 'eth_sendTransaction' as never,
          params: [
            {
              from: RESERVE,
              to: USDC,
              data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [from, 25_000_000n] }),
            },
          ] as never,
        })) as Hex;
        await pub.waitForTransactionReceipt({ hash: funding });
        console.log(`  funded the wallet with 25 fork USDC from the fork-only reserve ${RESERVE}: ${funding}`);
      } finally {
        await anvil('anvil_stopImpersonatingAccount', [RESERVE]);
      }
    }
    const [fromBefore, toBefore] = await Promise.all([usdcOf(from), usdcOf(transferTo)]);
    const hash = await sendAsUser(
      signer,
      USDC,
      encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [transferTo, five] }),
    );
    const receipt = await pub.waitForTransactionReceipt({ hash });
    const [fromAfter, toAfter] = await Promise.all([usdcOf(from), usdcOf(transferTo)]);
    const moved = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs }).find(
      (l) => isAddressEqual(l.address, USDC) && isAddressEqual(l.args.from, from) && isAddressEqual(l.args.to, transferTo),
    );
    console.log(`  ${hash} · block ${receipt.blockNumber} · gas ${receipt.gasUsed}`);
    check(receipt.status === 'success', 'mined on the fork');
    check(moved?.args.value === five, `the receipt's Transfer moved ${formatUnits(moved?.args.value ?? 0n, 6)} USDC out of the Privy wallet`);
    check(fromBefore - fromAfter === five, `the wallet's USDC ${formatUnits(fromBefore, 6)} → ${formatUnits(fromAfter, 6)}`);
    check(toAfter - toBefore === five, `the destination's USDC ${formatUnits(toBefore, 6)} → ${formatUnits(toAfter, 6)}`);
  }
}

main().then(
  () => {
    console.log(failures === 0 ? 'every check passed' : `${failures} check(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
