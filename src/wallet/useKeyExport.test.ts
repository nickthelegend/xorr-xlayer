/**
 * Exporting the key (PLAN.md 4.10): the web opens Privy's export window for this wallet, a phone says where to go.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_NEEDS_WALLET, EXPORT_ON_WEB } from './keyExport';

const exportWallet = vi.hoisted(() => vi.fn(async (_options?: { address: string }) => undefined));
vi.mock('@privy-io/react-auth', () => ({ useExportWallet: () => ({ exportWallet }) }));

const web = await import('./useKeyExport.web');
const native = await import('./useKeyExport.native');

const WALLET = '0x95A0b368588713011a15f4b1041423f31B08e615';

beforeEach(() => {
  exportWallet.mockClear();
});

describe('exporting the key', () => {
  it("opens Privy's export window on the web, for the signed-in wallet and no other", async () => {
    const e = web.useKeyExport(WALLET);

    expect(e.supported).toBe(true);
    if (e.supported) await e.exportKey();
    expect(exportWallet).toHaveBeenCalledWith({ address: WALLET });
  });

  it('asks for a sign-in before there is a wallet to export, and opens nothing', () => {
    expect(web.useKeyExport(undefined)).toEqual({ supported: false, reason: EXPORT_NEEDS_WALLET });
    expect(exportWallet).not.toHaveBeenCalled();
  });

  it('says on a phone where the export is, instead of offering a button that could not work', () => {
    expect(native.useKeyExport(WALLET)).toEqual({ supported: false, reason: EXPORT_ON_WEB });
    expect(EXPORT_ON_WEB).toContain('app.xorr.finance');
  });
});
