import { getAccessToken } from '@privy-io/react-auth';

/** The Privy access token the executor verifies on every request. */
export async function accessToken(): Promise<string | null> {
  return getAccessToken().catch(() => null);
}
