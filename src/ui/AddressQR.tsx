/**
 * The receiving address, as something a camera can read.
 *
 * Every funding rail ends the same way — USDC arriving at this address — and the person doing the
 * sending is almost always on a different device: another phone, an exchange in a browser.
 * Retyping 42 hex characters between two screens is where funding actually fails, and a mistyped
 * address on Base is money that is simply gone.
 *
 * WHY THIS DRAWS ITS OWN MODULES
 *
 * `react-native-qrcode-styled` is already a dependency and renders this in one line. On web it
 * also produces
 *
 *   Invalid DOM property `transform-origin`. Did you mean `transformOrigin`?
 *
 * on every render — react-native-svg's web layer turns the `scale`/`rotation` props the library
 * passes to each Path into an SVG attribute React DOM rejects. The warning is cosmetic and the
 * console is not: a screen that logs an error on load is the thing a whole audit day went into
 * removing, and "it's only a warning from a library" is how a console stops being worth reading.
 *
 * A QR is a grid of squares. Drawing it with plain `<Rect>` costs a few lines, passes no
 * transforms, and renders identically on both platforms.
 */
import React, { useMemo } from 'react';
import Svg, { Rect } from 'react-native-svg';
import QRC from 'qrcode';
import { colors } from './tokens';

export type AddressQRProps = {
  /** What the code encodes. An EIP-681 URI, so a wallet opens pre-filled on the right chain. */
  value: string;
  size?: number;
  /** Quiet zone, in modules. The spec asks for 4, and scanners genuinely need it. */
  quietZone?: number;
};

export function AddressQR({ value, size = 168, quietZone = 4 }: AddressQRProps) {
  const matrix = useMemo(() => {
    try {
      /*
       * Medium correction. An address is not long, so the denser levels buy nothing but smaller
       * modules — and a smaller module is a harder scan, which is the only thing that matters
       * here.
       */
      const qr = QRC.create(value, { errorCorrectionLevel: 'M' });
      const n = qr.modules.size;
      const bits = Array.from(qr.modules.data);
      return { n, at: (x: number, y: number) => Boolean(bits[y * n + x]) };
    } catch {
      // An unencodable value is not worth crashing the funding screen for.
      return null;
    }
  }, [value]);

  if (!matrix) return null;

  const total = matrix.n + quietZone * 2;
  const cells: React.ReactElement[] = [];
  for (let y = 0; y < matrix.n; y++) {
    for (let x = 0; x < matrix.n; x++) {
      if (!matrix.at(x, y)) continue;
      cells.push(
        <Rect
          key={`${x}-${y}`}
          x={x + quietZone}
          y={y + quietZone}
          width={1}
          height={1}
          fill={colors.scanInk}
        />,
      );
    }
  }

  return (
    // `scanInk`/`scanBg` rather than the ink ramp — see tokens.ts for why a code must not follow
    // the palette.
    <Svg width={size} height={size} viewBox={`0 0 ${total} ${total}`}>
      <Rect x={0} y={0} width={total} height={total} fill={colors.scanBg} />
      {cells}
    </Svg>
  );
}
