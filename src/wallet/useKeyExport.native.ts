/**
 * The phone half of `useKeyExport`. Privy's Expo SDK has no key export, so this says where the export is (PLAN.md 4.10).
 */
import { EXPORT_ON_WEB, type KeyExport } from './keyExport';

export function useKeyExport(_address: string | undefined): KeyExport {
  return { supported: false, reason: EXPORT_ON_WEB };
}
