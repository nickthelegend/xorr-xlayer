/**
 * agentGlyph — a face for every agent, drawn from its name.
 *
 * design.md §5 gives the orb one face: two pill eyes and a smile. Five gradients told the personas
 * apart, and an agent past the fifth had nothing of its own to wear — `agentGradient` handed any
 * unknown name Momentum Scout's blue. So the face is generated instead: eyes, a mouth and a mark on
 * the sphere are picked by a PRNG seeded from the name, with a little continuous variation on top so
 * two agents that draw the same three picks still sit differently.
 *
 * Deterministic by construction. There is no `Math.random` here: the same name draws the same face on
 * every screen, device and reload, and `agentGlyph.test.ts` pins it.
 *
 * What it leaves alone is the orb. The gradient geometry, the specular highlight and the bloom are
 * AgentOrb's, exactly as §5 specifies; a glyph is only what sits on the sphere.
 *
 * The output is data in a 100×100 box whose sphere is the circle of radius 50 at the centre, so one
 * description renders two ways: through react-native-svg in the app, where AgentOrb scales it to the
 * orb, and as an SVG string anywhere else — a README, a push image, `tools/agent-icons.ts`.
 */
import { agentGradient, type GradientPair } from './gradients';
import { hashSeed, normaliseSeed, pick, seededRandom } from './seed';

export const EYES = ['pill', 'dot', 'wide', 'square', 'visor', 'happy', 'sleepy', 'wink'] as const;
export const MOUTHS = ['smile', 'arc', 'flat', 'o', 'grin', 'smirk'] as const;
export const MARKS = ['none', 'band', 'ring', 'cheeks', 'crest', 'split', 'freckles'] as const;

export type EyeStyle = (typeof EYES)[number];
export type MouthStyle = (typeof MOUTHS)[number];
export type MarkStyle = (typeof MARKS)[number];

/** `ink` is the face's white. `deep` is black at low opacity, for marks set into the sphere. */
export type GlyphTone = 'ink' | 'deep';

export type PathSegment =
  | readonly ['M' | 'L', number, number]
  | readonly ['Q', number, number, number, number]
  | readonly ['A', number, number, number, 0 | 1, 0 | 1, number, number]
  | readonly ['H', number]
  | readonly ['Z'];

type Paint = { tone: GlyphTone; opacity: number };

export type GlyphShape =
  | ({ kind: 'rect'; x: number; y: number; w: number; h: number; r: number } & Paint)
  | ({ kind: 'circle'; cx: number; cy: number; r: number } & Paint)
  | ({ kind: 'fill'; d: readonly PathSegment[] } & Paint)
  | ({ kind: 'stroke'; d: readonly PathSegment[]; width: number } & Paint);

export interface AgentGlyph {
  /** The normalised name the face was drawn from. */
  seed: string;
  /** The orb's gradient — the persona's own from §1, or one from `AGENT_PALETTE`. */
  gradient: GradientPair;
  eyes: EyeStyle;
  mouth: MouthStyle;
  mark: MarkStyle;
  /** Drawn under the specular highlight, so the highlight stays the brightest thing on the sphere. */
  marks: GlyphShape[];
  /** Drawn over it, where the face has always been. */
  face: GlyphShape[];
}

/*
 * The §5 face, in the 100 box: AgentOrb's measurements off the 74px orb, × 100/74. Every generated
 * face is placed around these, so the family resemblance is the original face's proportions.
 */
const EYE_W = (9 / 74) * 100;
const EYE_H = (13 / 74) * 100;
const EYE_TOP = (30 / 74) * 100;
const EYE_INSET = (21 / 74) * 100;
const MOUTH_W = (16 / 74) * 100;
const MOUTH_H = (7 / 74) * 100;
const MOUTH_BOTTOM = (16 / 74) * 100;
/** Line features — happy eyes, a flat mouth — carry the same visual weight as the pill eyes. */
const STROKE = 4.2;

const INK: Paint = { tone: 'ink', opacity: 1 };
const ink = (opacity: number): Paint => ({ tone: 'ink', opacity });
const deep = (opacity: number): Paint => ({ tone: 'deep', opacity });

const M = (x: number, y: number): PathSegment => ['M', x, y];
const L = (x: number, y: number): PathSegment => ['L', x, y];
const Q = (cx: number, cy: number, x: number, y: number): PathSegment => ['Q', cx, cy, x, y];
const A = (r: number, large: 0 | 1, sweep: 0 | 1, x: number, y: number): PathSegment => [
  'A', r, r, 0, large, sweep, x, y,
];
const H = (x: number): PathSegment => ['H', x];
const Z: PathSegment = ['Z'];

const rect = (x: number, y: number, w: number, h: number, r: number, paint = INK): GlyphShape => ({
  kind: 'rect', x, y, w, h, r, ...paint,
});
const circle = (cx: number, cy: number, r: number, paint = INK): GlyphShape => ({
  kind: 'circle', cx, cy, r, ...paint,
});
const stroke = (d: PathSegment[], width = STROKE, paint = INK): GlyphShape => ({
  kind: 'stroke', d, width, ...paint,
});

function eyeShapes(style: EyeStyle, left: number, right: number, cy: number): GlyphShape[] {
  const pill = (cx: number) => rect(cx - EYE_W / 2, cy - EYE_H / 2, EYE_W, EYE_H, EYE_W / 2);
  const both = (draw: (cx: number) => GlyphShape) => [draw(left), draw(right)];
  switch (style) {
    case 'pill':
      return both(pill);
    case 'dot':
      return both((cx) => circle(cx, cy, 6.4));
    case 'wide':
      return both((cx) => rect(cx - 8.5, cy - 4.75, 17, 9.5, 4.75));
    case 'square':
      return both((cx) => rect(cx - 6.5, cy - 6.5, 13, 13, 3.2));
    case 'visor':
      return [rect(left - 9, cy - 5.5, right - left + 18, 11, 5.5)];
    case 'happy':
      return both((cx) => stroke([M(cx - 6.5, cy + 3), Q(cx, cy - 7, cx + 6.5, cy + 3)]));
    case 'sleepy':
      return both((cx) => stroke([M(cx - 6.5, cy + 1.5), L(cx + 6.5, cy + 1.5)]));
    case 'wink':
      return [pill(left), stroke([M(right - 6.5, cy + 1.5), Q(right, cy + 5.5, right + 6.5, cy + 1.5)])];
  }
}

function mouthShapes(style: MouthStyle, cy: number, width: number): GlyphShape[] {
  const x = 50 - width / 2;
  switch (style) {
    case 'smile': {
      // §5's own mouth: flat top, rounded underside.
      const top = cy - MOUTH_H / 2;
      const r = Math.min(MOUTH_H, width / 2);
      return [
        {
          kind: 'fill',
          d: [M(x, top), H(x + width), A(r, 0, 1, x + width - r, top + MOUTH_H), H(x + r), A(r, 0, 1, x, top), Z],
          ...INK,
        },
      ];
    }
    case 'arc':
      return [stroke([M(x + 1, cy - 3), Q(50, cy + 7, x + width - 1, cy - 3)])];
    case 'flat':
      return [stroke([M(50 - width * 0.36, cy), L(50 + width * 0.36, cy)])];
    case 'o':
      return [circle(50, cy, 4.6)];
    case 'grin': {
      const w = width + 3;
      return [rect(50 - w / 2, cy - 4.25, w, 8.5, 4.25)];
    }
    case 'smirk':
      return [stroke([M(x + 2, cy - 0.5), Q(53, cy + 6, x + width, cy - 4)])];
  }
}

function markShapes(style: MarkStyle): GlyphShape[] {
  switch (style) {
    case 'none':
      return [];
    case 'band':
      // A band across the brow, following the sphere's curve.
      return [stroke([M(17, 31), Q(50, 19, 83, 31)], 5, deep(0.2))];
    case 'ring':
      return [stroke([M(10, 50), A(40, 1, 0, 90, 50), A(40, 1, 0, 10, 50)], 2.6, ink(0.18))];
    case 'cheeks':
      return [circle(25, 63, 4.2, deep(0.18)), circle(75, 63, 4.2, deep(0.18))];
    case 'crest':
      return [circle(50, 15, 3.4, ink(0.55))];
    case 'split':
      // One line down the brow — the gap in the XORR. mark, on a face.
      return [stroke([M(50, 12), L(50, 27)], 3, deep(0.22))];
    case 'freckles':
      // Kept to the right: the upper left is the specular highlight's, and it must not move.
      return [circle(70, 29, 1.9, ink(0.4)), circle(76.5, 35, 1.6, ink(0.4)), circle(69, 38, 1.4, ink(0.4))];
  }
}

/** The face for a name. Same name, same face — on any screen, in any process. */
export function agentGlyph(name: string): AgentGlyph {
  const seed = normaliseSeed(name);
  // Its own stream, so the features never correlate with the palette `agentGradient` picked.
  const rand = seededRandom(`glyph:${seed}`);

  const eyes = pick(rand, EYES);
  const mouth = pick(rand, MOUTHS);
  const mark = pick(rand, MARKS);

  // Small continuous variation: eyes apart or together, a touch higher, a wider or lower mouth.
  const spread = (rand() - 0.5) * 6;
  const lift = (rand() - 0.6) * 5;
  const widen = (rand() - 0.5) * 6;
  const drop = (rand() - 0.5) * 4;

  const eyeY = EYE_TOP + EYE_H / 2 + lift;
  const left = EYE_INSET + EYE_W / 2 - spread;
  const right = 100 - EYE_INSET - EYE_W / 2 + spread;
  const mouthY = 100 - MOUTH_BOTTOM - MOUTH_H / 2 + drop;

  return {
    seed,
    gradient: agentGradient(name),
    eyes,
    mouth,
    mark,
    marks: markShapes(mark),
    face: [...eyeShapes(eyes, left, right, eyeY), ...mouthShapes(mouth, mouthY, MOUTH_W + widen)],
  };
}

/** Path data scaled from the 100 box by `unit`. Arc rotation and flags are not coordinates. */
export function pathData(d: readonly PathSegment[], unit = 1): string {
  const n = (v: number) => +(v * unit).toFixed(2);
  return d
    .map((s) => {
      switch (s[0]) {
        case 'M':
        case 'L':
          return `${s[0]} ${n(s[1])} ${n(s[2])}`;
        case 'Q':
          return `Q ${n(s[1])} ${n(s[2])} ${n(s[3])} ${n(s[4])}`;
        case 'A':
          return `A ${n(s[1])} ${n(s[2])} ${s[3]} ${s[4]} ${s[5]} ${n(s[6])} ${n(s[7])}`;
        case 'H':
          return `H ${n(s[1])}`;
        case 'Z':
          return 'Z';
      }
    })
    .join(' ');
}

/*
 * The two tones as colours, for the SVG string only. In the app AgentOrb maps them to `colors.ink`
 * and `colors.bg`, because nothing in src/ui may carry a bare hex.
 */
const TONE: Record<GlyphTone, string> = { ink: '#FFFFFF', deep: '#000000' };

function shapeSvg(s: GlyphShape): string {
  const o = s.opacity === 1 ? '' : ` opacity="${s.opacity}"`;
  const r2 = (v: number) => +v.toFixed(2);
  switch (s.kind) {
    case 'rect':
      return `<rect x="${r2(s.x)}" y="${r2(s.y)}" width="${r2(s.w)}" height="${r2(s.h)}" rx="${r2(s.r)}" fill="${TONE[s.tone]}"${o}/>`;
    case 'circle':
      return `<circle cx="${r2(s.cx)}" cy="${r2(s.cy)}" r="${r2(s.r)}" fill="${TONE[s.tone]}"${o}/>`;
    case 'fill':
      return `<path d="${pathData(s.d)}" fill="${TONE[s.tone]}"${o}/>`;
    case 'stroke':
      return `<path d="${pathData(s.d)}" fill="none" stroke="${TONE[s.tone]}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"${o}/>`;
  }
}

/**
 * The whole orb as a standalone SVG — gradient, marks, specular, face — using AgentOrb's recipe
 * numbers, for anywhere react-native-svg is not: files, HTML, images rendered on a server.
 */
export function agentGlyphSvg(name: string, size = 256): string {
  const g = agentGlyph(name);
  // Unique per name, so a page holding many faces never resolves one face's gradient to another's.
  const id = `xorr-agent-${hashSeed(name).toString(36)}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">`,
    '<defs>',
    `<radialGradient id="${id}" cx="32%" cy="26%" r="100.5%">`,
    `<stop offset="0" stop-color="${g.gradient.c1}"/><stop offset="0.74" stop-color="${g.gradient.c2}"/>`,
    '</radialGradient>',
    `<filter id="${id}-blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3.5"/></filter>`,
    '</defs>',
    `<circle cx="50" cy="50" r="50" fill="url(#${id})"/>`,
    ...g.marks.map(shapeSvg),
    `<ellipse cx="38" cy="26" rx="14" ry="9" fill="${TONE.ink}" opacity="0.5" filter="url(#${id}-blur)"/>`,
    ...g.face.map(shapeSvg),
    '</svg>',
  ].join('');
}
