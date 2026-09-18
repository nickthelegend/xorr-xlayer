"use client";

import { useReducedMotion } from "motion/react";
import { useId } from "react";
import { ICON_PATHS } from "@/components/ui/Icon";

const TRACKS = [
  "M-40 44 C 60 14, 150 74, 250 44 S 380 18, 460 46",
  "M-40 108 C 70 138, 160 78, 262 106 S 390 128, 460 102",
  "M-40 172 C 50 142, 170 202, 272 170 S 380 150, 460 176",
  "M-40 236 C 80 266, 180 206, 284 236 S 392 256, 460 230",
];

const TONES = {
  black: { from: "#34343c", to: "#0c0c0f", ink: "#C8F53C" },
  lavender: { from: "#d9ceff", to: "#8e74ee", ink: "#ffffff" },
  cobalt: { from: "#7f9dff", to: "#2446e6", ink: "#ffffff" },
  lime: { from: "#ecffb3", to: "#9fcf1f", ink: "#11170a" },
} as const;

/** Each tile glides back and forth over part of its track: the cap, the allowlist, the expiry, the fill. */
const TILES = [
  { track: 0, from: 0.62, to: 0.84, dur: 6.5, tone: "black", icon: "bolt" },
  { track: 1, from: 0.28, to: 0.52, dur: 7.8, tone: "lavender", icon: "shield" },
  { track: 2, from: 0.66, to: 0.88, dur: 7.1, tone: "cobalt", icon: "lock" },
  { track: 3, from: 0.4, to: 0.64, dur: 8.4, tone: "lime", icon: "trendingUp" },
] as const;

/** The reference's curved grooves with tokens sliding along them, as an SVG scene that scales with its card. */
export function RuleTracks({ className }: { className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const reduce = useReducedMotion();

  return (
    <svg viewBox="0 0 420 280" className={className} aria-hidden>
      <defs>
        {Object.entries(TONES).map(([tone, t]) => (
          <linearGradient key={tone} id={`${uid}-${tone}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={t.from} />
            <stop offset="1" stopColor={t.to} />
          </linearGradient>
        ))}
        <filter id={`${uid}-shadow`} x="-60%" y="-60%" width="220%" height="220%">
          <feDropShadow dx="0" dy="7" stdDeviation="6" floodColor="#000" floodOpacity="0.7" />
        </filter>
      </defs>

      {TRACKS.map((d, i) => (
        <g key={d}>
          <path
            id={`${uid}-track-${i}`}
            d={d}
            fill="none"
            stroke="rgba(255,255,255,0.035)"
            strokeWidth="16"
            strokeLinecap="round"
          />
          <path d={d} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="1" />
        </g>
      ))}

      {TILES.map((tile) => (
        <g key={tile.track} filter={`url(#${uid}-shadow)`}>
          <g transform="rotate(-8)">
            <rect
              x="-17"
              y="-17"
              width="34"
              height="34"
              rx="10"
              fill={`url(#${uid}-${tile.tone})`}
              stroke="rgba(255,255,255,0.22)"
              strokeWidth="1"
            />
            <svg
              x="-9"
              y="-9"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke={TONES[tile.tone].ink}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {ICON_PATHS[tile.icon]}
            </svg>
          </g>
          <animateMotion
            dur={`${tile.dur}s`}
            repeatCount="indefinite"
            calcMode="spline"
            keyTimes="0;0.5;1"
            keySplines="0.45 0 0.55 1;0.45 0 0.55 1"
            keyPoints={reduce ? `${tile.from};${tile.from};${tile.from}` : `${tile.from};${tile.to};${tile.from}`}
          >
            <mpath href={`#${uid}-track-${tile.track}`} />
          </animateMotion>
        </g>
      ))}
    </svg>
  );
}
