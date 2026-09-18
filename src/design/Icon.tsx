/**
 * Icon set — design.md §4 / §5. 24x24 viewBox, stroke-width 1.8, round cap + join, no fill.
 *
 * The five tab icons are ported verbatim from design.md §4 (the paths are given there and are
 * authoritative). The rest are drawn to the same optical weight: same viewBox, same stroke,
 * same cap/join, so nothing in the set looks heavier than its neighbour.
 */
import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

export type IconName =
  | 'home'
  | 'markets'
  | 'bot'
  | 'strategies'
  | 'assets'
  | 'search'
  | 'back'
  | 'gear'
  | 'star'
  | 'starFilled'
  | 'more'
  | 'close'
  | 'chevron'
  | 'plus'
  | 'minus'
  | 'swap'
  | 'check'
  | 'send'
  | 'bell'
  | 'sort'
  | 'grid'
  | 'swapH'
  | 'shield'
  | 'activity'
  | 'chat'
  | 'copy'
  | 'mic'
  | 'waveform'
  | 'sparkle'
  | 'sun'
  | 'moon';

export type IconProps = {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
};

/** design.md §4: 21x21 in the tab bar; 1.8 stroke everywhere. */
export function Icon({ name, size = 21, color = 'currentColor', strokeWidth = 1.8 }: IconProps) {
  const common = {
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {render(name, common, color)}
    </Svg>
  );
}

/** The shared stroke attributes every glyph carries — design.md §4. */
type Common = {
  stroke: string;
  strokeWidth: number;
  strokeLinecap: 'round';
  strokeLinejoin: 'round';
  fill: string;
};

function render(name: IconName, c: Common, color: string) {
  switch (name) {
    // ── Tab icons, verbatim from design.md §4 ────────────────────────────────
    case 'home':
      return (
        <>
          <Path d="M3 10.5 L12 3.5 L21 10.5 V20 a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" {...c} />
          <Path d="M9.5 21v-6h5v6" {...c} />
        </>
      );
    case 'markets':
      return (
        <>
          <Path d="M4 4v16h16" {...c} />
          <Path d="M7.5 15.5 L11 11 L14 13.5 L19.5 7" {...c} />
        </>
      );
    case 'bot':
      // design.md §4 "Agents": circle r=8.5, two filled eye dots r=1.15, smile arc.
      return (
        <>
          <Circle cx={12} cy={12} r={8.5} {...c} />
          <Circle cx={9.3} cy={10.4} r={1.15} fill={color} stroke="none" />
          <Circle cx={14.7} cy={10.4} r={1.15} fill={color} stroke="none" />
          <Path d="M9.4 15.2a3.6 3.6 0 0 0 5.2 0" {...c} />
        </>
      );
    case 'strategies':
      // Was design.md's "Trade" slot (two opposed arrows) — PLAN.md §3.5 repurposes the tab,
      // and the two-arrow glyph still reads as "flows running", so it is kept verbatim.
      return (
        <>
          <Path d="M7 4v16" {...c} />
          <Path d="M4 7.5 L7 4 L10 7.5" {...c} />
          <Path d="M17 20V4" {...c} />
          <Path d="M20 16.5 L17 20 L14 16.5" {...c} />
        </>
      );
    case 'assets':
      return (
        <>
          <Rect x={3} y={6.5} width={18} height={13} rx={2.5} {...c} />
          <Path d="M3 10.5h18" {...c} />
          <Path d="M16.5 15h2" {...c} />
        </>
      );

    // ── Supporting glyphs, same optical weight ───────────────────────────────
    case 'search':
      return (
        <>
          <Circle cx={10.5} cy={10.5} r={6.5} {...c} />
          <Path d="M15.5 15.5 L21 21" {...c} />
        </>
      );
    case 'back':
      return <Path d="M15 4.5 L7.5 12 L15 19.5" {...c} />;
    case 'chevron':
      return <Path d="M9.5 4.5 L17 12 L9.5 19.5" {...c} />;
    case 'gear':
      return (
        <>
          <Circle cx={12} cy={12} r={3.2} {...c} />
          <Path
            d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"
            {...c}
          />
        </>
      );
    case 'star':
      return <Path d="M12 3.6 L14.6 9.2 L20.6 10 L16.2 14.1 L17.4 20 L12 17.1 L6.6 20 L7.8 14.1 L3.4 10 L9.4 9.2 Z" {...c} />;
    case 'starFilled':
      return (
        <Path
          d="M12 3.6 L14.6 9.2 L20.6 10 L16.2 14.1 L17.4 20 L12 17.1 L6.6 20 L7.8 14.1 L3.4 10 L9.4 9.2 Z"
          fill={color}
          stroke={color}
          strokeWidth={1.8}
          strokeLinejoin="round"
        />
      );
    case 'more':
      return (
        <>
          <Circle cx={5.5} cy={12} r={1.35} fill={color} stroke="none" />
          <Circle cx={12} cy={12} r={1.35} fill={color} stroke="none" />
          <Circle cx={18.5} cy={12} r={1.35} fill={color} stroke="none" />
        </>
      );
    case 'close':
      return (
        <>
          <Path d="M6 6 L18 18" {...c} />
          <Path d="M18 6 L6 18" {...c} />
        </>
      );
    case 'plus':
      return (
        <>
          <Path d="M12 5.5v13" {...c} />
          <Path d="M5.5 12h13" {...c} />
        </>
      );
    case 'minus':
      return <Path d="M5.5 12h13" {...c} />;
    case 'swap':
      // screens.md screen 19: the vertical up/down pair inside the 40px seam circle.
      return (
        <>
          <Path d="M8 4.5v15" {...c} />
          <Path d="M4.5 8 L8 4.5 L11.5 8" {...c} />
          <Path d="M16 19.5v-15" {...c} />
          <Path d="M19.5 16 L16 19.5 L12.5 16" {...c} />
        </>
      );
    case 'check':
      return <Path d="M5 12.5 L10 17.5 L19 7" {...c} />;
    case 'mic':
      return (
        <>
          <Rect x={9} y={3.5} width={6} height={11} rx={3} {...c} />
          <Path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" {...c} />
          <Path d="M12 18v2.5" {...c} />
        </>
      );
    case 'waveform':
      return (
        <>
          <Path d="M4.5 10.5v3" {...c} />
          <Path d="M8.25 7.5v9" {...c} />
          <Path d="M12 4.5v15" {...c} />
          <Path d="M15.75 8v8" {...c} />
          <Path d="M19.5 10.5v3" {...c} />
        </>
      );
    case 'sparkle':
      return (
        <>
          <Path d="M11 5c.6 3.4 2.6 5.4 6 6-3.4.6-5.4 2.6-6 6-.6-3.4-2.6-5.4-6-6 3.4-.6 5.4-2.6 6-6Z" {...c} />
          <Path d="M18.5 3v3.5M16.75 4.75h3.5" {...c} />
        </>
      );
    case 'sun':
      return (
        <>
          <Circle cx={12} cy={12} r={4} {...c} />
          <Path d="M12 2.75v2M12 19.25v2M2.75 12h2M19.25 12h2M5.46 5.46l1.41 1.41M17.13 17.13l1.41 1.41M5.46 18.54l1.41-1.41M17.13 6.87l1.41-1.41" {...c} />
        </>
      );
    case 'moon':
      return <Path d="M19.5 14.2A7.5 7.5 0 0 1 9.8 4.5a7.75 7.75 0 1 0 9.7 9.7Z" {...c} />;
    case 'send':
      return (
        <>
          <Path d="M12 19.5v-15" {...c} />
          <Path d="M6 10.5 L12 4.5 L18 10.5" {...c} />
        </>
      );
    case 'bell':
      return (
        <>
          <Path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10Z" {...c} />
          <Path d="M10.2 18.5a2 2 0 0 0 3.6 0" {...c} />
        </>
      );
    case 'sort':
      return (
        <>
          <Path d="M4.5 7h15" {...c} />
          <Path d="M7 12h10" {...c} />
          <Path d="M10 17h4" {...c} />
        </>
      );

    // ── The simple shell (2026-09-12) ────────────────────────────────────────
    case 'grid':
      return (
        <>
          <Rect x={3.5} y={3.5} width={7} height={7} rx={2} {...c} />
          <Rect x={13.5} y={3.5} width={7} height={7} rx={2} {...c} />
          <Rect x={3.5} y={13.5} width={7} height={7} rx={2} {...c} />
          <Rect x={13.5} y={13.5} width={7} height={7} rx={2} {...c} />
        </>
      );
    case 'swapH':
      // ⇄ — two opposed horizontal arrows, the way wallets draw "swap".
      return (
        <>
          <Path d="M4.5 8.5h14" {...c} />
          <Path d="M15 5 L18.5 8.5 L15 12" {...c} />
          <Path d="M19.5 15.5h-14" {...c} />
          <Path d="M9 12 L5.5 15.5 L9 19" {...c} />
        </>
      );
    case 'shield':
      return <Path d="M12 3.5 L19 6.3 V11.5 C19 16.1 16 19.5 12 21 C8 19.5 5 16.1 5 11.5 V6.3 Z" {...c} />;
    case 'activity':
      return <Path d="M3 12h4 l2.5-6 l5 12 l2.5-6 H21" {...c} />;
    case 'chat':
      // The speech bubble with the agent's face — the same bot the roster and proposal cards draw.
      return (
        <>
          <Path
            d="M21 11.5c0 4.14-4.03 7.5-9 7.5a10.5 10.5 0 0 1-2.6-.32L4.5 20.5l1.2-3.2A7.02 7.02 0 0 1 3 11.5C3 7.36 7.03 4 12 4s9 3.36 9 7.5Z"
            {...c}
          />
          <Circle cx={9.2} cy={11.2} r={1.15} fill={color} stroke="none" />
          <Circle cx={14.8} cy={11.2} r={1.15} fill={color} stroke="none" />
          <Path d="M9.3 14.2a3.4 3.4 0 0 0 5.4 0" {...c} />
        </>
      );
    case 'copy':
      // Two sheets, the front one whole — the way every wallet draws "copy".
      return (
        <>
          <Rect x={8.5} y={8.5} width={12} height={12} rx={2.5} {...c} />
          <Path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" {...c} />
        </>
      );
  }
}
