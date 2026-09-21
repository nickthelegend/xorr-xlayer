/**
 * Issue a real Privy access token for a TEST account.
 *
 * Privy only mints tokens from a client login, which made the whole authenticated surface
 * untestable in CI. `getTestAccessToken` is Privy's own supported path for exactly this — a real,
 * signature-valid token for a test identity, verified by the same `verifyAuthToken` the executor
 * uses in production. Nothing about the auth path is bypassed or stubbed.
 */
import 'dotenv/config';
import { privy } from './auth/privy.js';

const email = process.argv[2] ?? 'e2e-test@xorr.finance';

/*
 * A refusal from Privy is reported as a sentence, not as its SDK's stack.
 *
 * Minting enough tokens in a session earns a 429, and the whole harness then died in a wall of minified
 * `@privy-io/server-auth` source with `e [Error]: Too many requests` somewhere inside it — a reader had to
 * know the SDK to see that nothing was wrong with the app at all. The cause matters more than the trace: a
 * rate limit is "wait", a bad key is "fix your env", and neither is a bug in what is being tested.
 */
try {
  const { accessToken } = await privy.getTestAccessToken({ email });
  process.stdout.write(accessToken);
} catch (e: unknown) {
  const status = (e as { status?: number })?.status;
  const detail = e instanceof Error ? e.message : String(e);
  const said =
    status === 429
      ? `Privy is rate-limiting test tokens right now (429): ${detail} Wait a minute and run it again.`
      : status === 401 || status === 403
        ? `Privy refused the app credentials (${status}): ${detail} Check PRIVY_APP_ID and PRIVY_APP_SECRET.`
        : `Privy would not mint a test token for ${email}: ${detail}`;
  process.stderr.write(`${said}\n`);
  process.exit(1);
}
