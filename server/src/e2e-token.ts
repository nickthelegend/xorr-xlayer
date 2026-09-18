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
const { accessToken } = await privy.getTestAccessToken({ email });
process.stdout.write(accessToken);
