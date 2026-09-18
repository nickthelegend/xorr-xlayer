/**
 * The web half of `useKeyExport`: Privy's own export window, for this wallet and no other (PLAN.md 4.10).
 */
import { useExportWallet } from '@privy-io/react-auth';
import { EXPORT_NEEDS_WALLET, type KeyExport } from './keyExport';

export function useKeyExport(address: string | undefined): KeyExport {
  const { exportWallet } = useExportWallet();
  if (!address) return { supported: false, reason: EXPORT_NEEDS_WALLET };
  // Privy shows the key in its frame; the promise settles when the person closes that window.
  return { supported: true, exportKey: () => exportWallet({ address }) };
}
