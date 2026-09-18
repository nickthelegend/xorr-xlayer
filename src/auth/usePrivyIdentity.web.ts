/**
 * Who is signed in, as Privy knows them — web. See `usePrivyIdentity.native.ts`.
 */
import { usePrivy } from '@privy-io/react-auth';

export function usePrivyIdentity(): { email: string | null; name: string | null } {
  const { user } = usePrivy();
  const email = user?.email?.address ?? null;
  const handle = user?.twitter?.username;
  return { email, name: email ?? user?.google?.email ?? (handle ? `@${handle}` : null) };
}
