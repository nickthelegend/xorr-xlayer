/**
 * `qrcode` ships no types and `@types/qrcode` is not a dependency here.
 *
 * Only the one call `AddressQR` makes is declared, deliberately narrow: a broad `declare module
 * 'qrcode'` would type the whole package as `any` and hide a real mistake in the one place this is
 * used. The shape below is what `QRC.create` actually returns — a flat byte array plus the grid
 * width, which is why the renderer indexes it as `y * size + x`.
 */
declare module 'qrcode' {
  export function create(
    data: string,
    options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'; version?: number },
  ): { modules: { size: number; data: Uint8Array } };
}
