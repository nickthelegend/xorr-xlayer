/**
 * Issue a real Privy access token for a TEST account.
 *
 * Privy only mints tokens from a client login, which made the whole authenticated surface
 * untestable in CI. A test account is Privy's own supported path for exactly this — a real,
 * signature-valid token for a test identity, verified by the same `verifyAuthToken` the executor
 * uses in production. Nothing about the auth path is bypassed or stubbed.
 *
 * It logs in the way the SDK's `getTestAccessToken` does — the test account's own email and code, through Privy's
 * passwordless endpoint — but names the site it is logging in for. An app with an allowed-domains list refuses a login
 * that names none ("Must specify origin", 403), which is what the SDK sends; the app this deployment moved to on
 * 2026-09-25 has such a list, and the token the site itself would receive is the one worth testing with.
 */
import 'dotenv/config';

const email = (process.argv[2] ?? 'e2e-test@xorr.finance').trim().toLowerCase();
const APP_ID = process.env.PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;
/** The site the login is for: one of the app's allowed domains. */
const ORIGIN = process.env.XORR_WEB_ORIGIN ?? 'https://xorr-xlayer.vercel.app';
const AUTH = 'https://auth.privy.io';

class PrivyRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function privy<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${AUTH}${path}`, {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString('base64')}`,
      'privy-app-id': APP_ID!,
      origin: ORIGIN,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = (text ? JSON.parse(text) : {}) as T & { error?: string };
  if (!res.ok) throw new PrivyRefusal(res.status, body.error ?? res.statusText);
  return body;
}

/*
 * A refusal from Privy is reported as a sentence, not as a stack.
 *
 * Minting enough tokens in a session earns a 429, and the whole harness then died in a wall of minified SDK source
 * with `Too many requests` somewhere inside it — a reader had to know the SDK to see that nothing was wrong with the
 * app at all. The cause matters more than the trace: a rate limit is "wait", a bad key is "fix your env", and neither
 * is a bug in what is being tested.
 */
try {
  if (!APP_ID || !APP_SECRET) throw new PrivyRefusal(0, 'PRIVY_APP_ID and PRIVY_APP_SECRET are not set.');
  const listed = await privy<{ data?: { email: string; otp_code: string }[] }>(`/api/v1/apps/${APP_ID}/test_credentials`);
  const accounts = listed.data ?? [];
  if (accounts.length === 0) throw new PrivyRefusal(0, 'Test accounts are not enabled for this app (dashboard → Authentication → Advanced).');
  const account = accounts.find((a) => a.email.toLowerCase() === email);
  if (!account) throw new PrivyRefusal(0, `No test account ${email}. This app has: ${accounts.map((a) => a.email).join(', ')}.`);
  const { token } = await privy<{ token: string }>('/api/v1/passwordless/authenticate', {
    method: 'POST',
    body: JSON.stringify({ email: account.email, code: account.otp_code }),
  });
  process.stdout.write(token);
} catch (e: unknown) {
  const status = e instanceof PrivyRefusal ? e.status : undefined;
  const detail = e instanceof Error ? e.message : String(e);
  const said =
    status === 429
      ? `Privy is rate-limiting test tokens right now (429): ${detail} Wait a minute and run it again.`
      : status === 401 || status === 403
        ? `Privy refused the app credentials (${status}): ${detail} Check PRIVY_APP_ID, PRIVY_APP_SECRET and XORR_WEB_ORIGIN.`
        : `Privy would not mint a test token for ${email}: ${detail}`;
  process.stderr.write(`${said}\n`);
  process.exit(1);
}
