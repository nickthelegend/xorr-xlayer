/**
 * Can this wallet actually hold this xStock? (PLAN.md §8.4)
 *
 * xStocks are jurisdiction-restricted tokenized equities, and Token-2022 gives the issuer several
 * independent ways to refuse a transfer. Finding out at signing time means a user watches a
 * transaction fail on-chain for reasons nobody explained. This asks first.
 *
 * What the issuer actually controls on these mints, read from mainnet rather than assumed:
 *
 *   TransferHook          an extension that can point at a program which vets every transfer.
 *                         On today's xStock mints the extension is PRESENT but its programId is
 *                         the all-zero default, which means NO hook program is configured and no
 *                         on-chain allow-list is being consulted. That is reported as its own
 *                         outcome — `not-configured` — and never as a pass, because "we checked
 *                         an allow-list and you're on it" and "there is no allow-list" are
 *                         completely different statements to make to a user. The authority on the
 *                         extension can set a hook later, at which point this starts enforcing.
 *   PausableConfig        a global stop. While paused, every transfer of the token fails.
 *   Freeze authority      per-account. A frozen token account cannot send or receive.
 *   DefaultAccountState   what a NEWLY created account starts as. Where that is Frozen, a first-
 *                         time buyer receives an account they cannot use until the issuer thaws it.
 *
 * A check that cannot be read is `unknown`, and any unknown makes the whole answer indeterminate
 * rather than eligible. Refusing to guess is the entire point: telling someone they are cleared
 * to buy a restricted security, on the strength of an RPC call that failed, is the worst
 * available outcome.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import {
  getMint,
  getTransferHook,
  getPausableConfig,
  getDefaultAccountState,
  getPermanentDelegate,
  getAccount,
  AccountState,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { connection as defaultConnection } from './connection.js';
import { ataFor, tokenProgramForMint, toPublicKey } from './balances.js';

export type CheckId =
  | 'mint-paused'
  | 'transfer-hook'
  | 'account-frozen'
  | 'default-account-state';

export type CheckStatus = 'pass' | 'blocked' | 'not-configured' | 'unknown';

export type EligibilityCheck = {
  id: CheckId;
  title: string;
  status: CheckStatus;
  /** A sentence for a person, not a code. */
  detail: string;
};

export type Eligibility = {
  wallet: string;
  mint: string;
  /** True only when every gate was read AND none of them blocks. */
  eligible: boolean;
  /** True when something could not be read. Never present this as cleared. */
  indeterminate: boolean;
  checks: EligibilityCheck[];
  /** One sentence explaining the verdict. */
  summary: string;
  /** The issuer can seize tokens from any account. Disclosure, not a gate. */
  permanentDelegate: string | null;
};

const HOOK_TITLE = 'Transfer allow-list';

function verdict(checks: EligibilityCheck[]): Pick<Eligibility, 'eligible' | 'indeterminate' | 'summary'> {
  const blocked = checks.filter((c) => c.status === 'blocked');
  const unknown = checks.filter((c) => c.status === 'unknown');

  if (blocked.length > 0) {
    return {
      eligible: false,
      indeterminate: false,
      summary: blocked[0]!.detail,
    };
  }
  if (unknown.length > 0) {
    return {
      eligible: false,
      indeterminate: true,
      summary: `Could not confirm eligibility: ${unknown[0]!.detail}`,
    };
  }
  /*
   * Deliberately worded around what was actually established. Where no hook is configured there is
   * no allow-list to be on, and saying "you are approved" would invent an approval nobody granted.
   */
  const noHook = checks.some((c) => c.id === 'transfer-hook' && c.status === 'not-configured');
  return {
    eligible: true,
    indeterminate: false,
    summary: noHook
      ? 'Nothing on this mint blocks the transfer. The issuer has not configured a transfer allow-list, so no allow-list was consulted.'
      : 'This wallet passes the issuer’s transfer checks for this token.',
  };
}

export async function checkEligibility(
  wallet: PublicKey | string,
  mint: PublicKey | string,
  conn: Connection = defaultConnection,
): Promise<Eligibility> {
  const walletPk = toPublicKey(wallet);
  const mintPk = toPublicKey(mint);
  const prog = tokenProgramForMint(mintPk);
  const checks: EligibilityCheck[] = [];
  let permanentDelegate: string | null = null;

  // Everything below hangs off the mint, so a mint we cannot read is a total unknown.
  let mintInfo;
  try {
    mintInfo = await getMint(conn, mintPk, 'confirmed', prog);
  } catch (err) {
    const detail = `the token's mint could not be read (${err instanceof Error ? err.message : String(err)}).`;
    for (const [id, title] of [
      ['mint-paused', 'Transfers paused'],
      ['transfer-hook', HOOK_TITLE],
      ['account-frozen', 'Account frozen'],
      ['default-account-state', 'New account state'],
    ] as const) {
      checks.push({ id, title, status: 'unknown', detail });
    }
    return { wallet: walletPk.toBase58(), mint: mintPk.toBase58(), checks, permanentDelegate, ...verdict(checks) };
  }

  // Only Token-2022 carries any of these. A plain SPL mint has no issuer gates at all.
  if (!prog.equals(TOKEN_2022_PROGRAM_ID)) {
    checks.push({
      id: 'transfer-hook',
      title: HOOK_TITLE,
      status: 'not-configured',
      detail: 'This is a plain SPL token, which has no transfer-hook mechanism.',
    });
    return { wallet: walletPk.toBase58(), mint: mintPk.toBase58(), checks, permanentDelegate, ...verdict(checks) };
  }

  permanentDelegate = getPermanentDelegate(mintInfo)?.delegate.toBase58() ?? null;

  // 1. A global pause stops every transfer of the token, whoever is sending.
  const pausable = getPausableConfig(mintInfo);
  if (!pausable) {
    checks.push({
      id: 'mint-paused',
      title: 'Transfers paused',
      status: 'not-configured',
      detail: 'This token cannot be paused by its issuer.',
    });
  } else if (pausable.paused) {
    checks.push({
      id: 'mint-paused',
      title: 'Transfers paused',
      status: 'blocked',
      detail: 'The issuer has paused all transfers of this token. No buy can settle until it is unpaused.',
    });
  } else {
    checks.push({
      id: 'mint-paused',
      title: 'Transfers paused',
      status: 'pass',
      detail: 'Transfers of this token are not paused.',
    });
  }

  // 2. The allow-list, if the issuer has actually pointed the extension at a program.
  const hook = getTransferHook(mintInfo);
  if (!hook || hook.programId.equals(PublicKey.default)) {
    checks.push({
      id: 'transfer-hook',
      title: HOOK_TITLE,
      status: 'not-configured',
      detail: hook
        ? 'The mint reserves a transfer hook but no program is set, so no on-chain allow-list is enforced today. The issuer can set one at any time.'
        : 'This mint has no transfer-hook extension, so no on-chain allow-list is enforced.',
    });
  } else {
    /*
     * A configured hook vets transfers through its own accounts. The spec requires an
     * `extra-account-metas` PDA describing what it needs; without that the transfer cannot even
     * be assembled, which is a blocked transfer rather than an unknown one.
     */
    const [extraMetas] = PublicKey.findProgramAddressSync(
      [Buffer.from('extra-account-metas'), mintPk.toBuffer()],
      hook.programId,
    );
    try {
      const [program, metas] = await Promise.all([
        conn.getAccountInfo(hook.programId),
        conn.getAccountInfo(extraMetas),
      ]);
      if (!program?.executable) {
        checks.push({
          id: 'transfer-hook',
          title: HOOK_TITLE,
          status: 'blocked',
          detail: `The mint points at transfer-hook program ${hook.programId.toBase58()}, which is not deployed on this cluster, so transfers cannot settle.`,
        });
      } else if (!metas) {
        checks.push({
          id: 'transfer-hook',
          title: HOOK_TITLE,
          status: 'blocked',
          detail: `Transfer-hook program ${hook.programId.toBase58()} has published no account list for this mint, so a transfer cannot be built.`,
        });
      } else {
        /*
         * The hook is live and well-formed. Whether it admits THIS wallet is a question only its
         * own program logic answers, and guessing is exactly what this module exists not to do.
         */
        checks.push({
          id: 'transfer-hook',
          title: HOOK_TITLE,
          status: 'unknown',
          detail: `Transfer-hook program ${hook.programId.toBase58()} vets every transfer of this token, and whether it admits this wallet can only be settled by simulating the transfer.`,
        });
      }
    } catch (err) {
      checks.push({
        id: 'transfer-hook',
        title: HOOK_TITLE,
        status: 'unknown',
        detail: `the transfer-hook program could not be read (${err instanceof Error ? err.message : String(err)}).`,
      });
    }
  }

  // 3. This wallet's own token account, which the freeze authority can disable individually.
  const ata = ataFor(walletPk, mintPk, prog);
  const defaultState = getDefaultAccountState(mintInfo);
  try {
    const account = await getAccount(conn, ata, 'confirmed', prog);
    if (account.isFrozen) {
      checks.push({
        id: 'account-frozen',
        title: 'Account frozen',
        status: 'blocked',
        detail: 'This wallet’s token account for this xStock has been frozen by the issuer, so it cannot receive or send.',
      });
    } else {
      checks.push({
        id: 'account-frozen',
        title: 'Account frozen',
        status: 'pass',
        detail: 'This wallet’s token account is active.',
      });
    }
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError || err instanceof TokenInvalidAccountOwnerError) {
      // No account yet is the normal first-buy case; what matters is the state it will be born in.
      checks.push({
        id: 'account-frozen',
        title: 'Account frozen',
        status: 'pass',
        detail: 'This wallet does not hold this xStock yet; the account is created by the buy.',
      });
    } else {
      checks.push({
        id: 'account-frozen',
        title: 'Account frozen',
        status: 'unknown',
        detail: `this wallet's token account could not be read (${err instanceof Error ? err.message : String(err)}).`,
      });
    }
  }

  // 4. What a newly created account starts as — the gate a first-time buyer actually meets.
  if (!defaultState) {
    checks.push({
      id: 'default-account-state',
      title: 'New account state',
      status: 'not-configured',
      detail: 'New accounts for this token start active.',
    });
  } else if (defaultState.state === AccountState.Frozen) {
    checks.push({
      id: 'default-account-state',
      title: 'New account state',
      status: 'blocked',
      detail: 'New accounts for this token are created frozen, so this wallet cannot receive it until the issuer thaws the account.',
    });
  } else {
    checks.push({
      id: 'default-account-state',
      title: 'New account state',
      status: 'pass',
      detail: 'New accounts for this token are created active.',
    });
  }

  return {
    wallet: walletPk.toBase58(),
    mint: mintPk.toBase58(),
    checks,
    permanentDelegate,
    ...verdict(checks),
  };
}
