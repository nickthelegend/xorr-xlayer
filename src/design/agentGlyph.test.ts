/**
 * The procedural faces, pinned.
 *
 * A face is an identity, so what is tested is what would quietly break one: the same name drawing a
 * different face, a persona losing the gradient §1 gave it, an unknown agent turning up in a
 * persona's colours, or a feature sliding off the sphere at a seed nobody happened to look at.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_PALETTE, agentGradient, agentGradients } from './gradients';
import {
  EYES,
  MARKS,
  MOUTHS,
  agentGlyph,
  agentGlyphSvg,
  pathData,
  type GlyphShape,
} from './agentGlyph';

const PERSONAS = ['Momentum Scout', 'Earnings Desk', 'Yield Keeper', 'Drawdown Guard', 'Strategist'] as const;
const SAMPLES = Array.from({ length: 400 }, (_, i) => `agent-${i}`);

/** How far a shape reaches from the sphere's centre, in the 100 box. */
function reach(shape: GlyphShape): number {
  const from = (x: number, y: number) => Math.hypot(x - 50, y - 50);
  switch (shape.kind) {
    case 'rect':
      return Math.max(
        from(shape.x, shape.y),
        from(shape.x + shape.w, shape.y),
        from(shape.x, shape.y + shape.h),
        from(shape.x + shape.w, shape.y + shape.h),
      );
    case 'circle':
      return from(shape.cx, shape.cy) + shape.r;
    case 'fill':
    case 'stroke': {
      const pad = shape.kind === 'stroke' ? shape.width / 2 : 0;
      let far = 0;
      for (const s of shape.d) {
        const points = s[0] === 'A' ? [s[6], s[7]] : s[0] === 'H' || s[0] === 'Z' ? [] : (s.slice(1) as number[]);
        for (let i = 0; i + 1 < points.length; i += 2) far = Math.max(far, from(points[i]!, points[i + 1]!) + pad);
      }
      return far;
    }
  }
}

describe('agentGlyph — a face drawn from a name', () => {
  it('draws the same face for the same name, however the name is typed', () => {
    expect(agentGlyph('  momentum   SCOUT ')).toEqual(agentGlyph('Momentum Scout'));
    expect(agentGlyph('Night Owl')).toEqual(agentGlyph('Night Owl'));
  });

  it('keeps every persona in the gradient design.md §1 gave it', () => {
    for (const p of PERSONAS) expect(agentGlyph(p).gradient, p).toEqual(agentGradients[p]);
  });

  it("never dresses an unknown agent in a persona's colours", () => {
    const personas = Object.values(agentGradients).map((g) => g.c1 + g.c2);
    const palette = AGENT_PALETTE.map((g) => g.c1 + g.c2);
    for (const s of SAMPLES) {
      const { c1, c2 } = agentGlyph(s).gradient;
      expect(palette, s).toContain(c1 + c2);
      expect(personas, s).not.toContain(c1 + c2);
    }
  });

  it('agrees with agentGradient, so the orb and the face on it are one identity', () => {
    for (const s of [...PERSONAS, ...SAMPLES]) expect(agentGlyph(s).gradient, s).toEqual(agentGradient(s));
  });

  it('uses the whole vocabulary rather than a few favourites', () => {
    const eyes = new Set<string>();
    const mouths = new Set<string>();
    const marks = new Set<string>();
    const palettes = new Set<string>();
    const combos = new Set<string>();
    for (const s of SAMPLES) {
      const g = agentGlyph(s);
      eyes.add(g.eyes);
      mouths.add(g.mouth);
      marks.add(g.mark);
      palettes.add(g.gradient.c1);
      combos.add(`${g.eyes}/${g.mouth}/${g.mark}`);
    }
    expect([...eyes].sort()).toEqual([...EYES].sort());
    expect([...mouths].sort()).toEqual([...MOUTHS].sort());
    expect([...marks].sort()).toEqual([...MARKS].sort());
    expect(palettes.size).toBe(AGENT_PALETTE.length);
    expect(combos.size).toBeGreaterThan(150);
  });

  it('gives neighbouring names different faces', () => {
    for (let i = 1; i < SAMPLES.length; i += 1) {
      const a = JSON.stringify(agentGlyph(SAMPLES[i - 1]!).face);
      const b = JSON.stringify(agentGlyph(SAMPLES[i]!).face);
      expect(b, SAMPLES[i]).not.toBe(a);
    }
  });

  it('keeps every feature on the sphere, at every seed', () => {
    for (const s of [...PERSONAS, ...SAMPLES]) {
      const g = agentGlyph(s);
      for (const shape of [...g.marks, ...g.face]) {
        expect(reach(shape), `${s}: ${shape.kind}`).toBeLessThanOrEqual(46);
      }
    }
  });
});

describe('rendering a glyph', () => {
  it('scales coordinates, and leaves arc rotation and flags alone', () => {
    expect(pathData([['M', 10, 20], ['A', 5, 5, 0, 1, 0, 30, 40], ['H', 7], ['Z']], 2)).toBe(
      'M 20 40 A 10 10 0 1 0 60 80 H 14 Z',
    );
  });

  it("writes a complete SVG carrying the orb's own gradient", () => {
    const svg = agentGlyphSvg('Yield Keeper', 128);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('width="128"');
    expect(svg).toContain('viewBox="0 0 100 100"');
    expect(svg).toContain(`stop-color="${agentGradients['Yield Keeper'].c1}"`);
    expect(svg).toContain(`stop-color="${agentGradients['Yield Keeper'].c2}"`);
    expect(svg).not.toMatch(/NaN|undefined/);
  });

  it('gives each name its own gradient id, so many faces can share one page', () => {
    const id = (svg: string) => /radialGradient id="([^"]+)"/.exec(svg)?.[1];
    expect(id(agentGlyphSvg('agent-1'))).toBeTruthy();
    expect(id(agentGlyphSvg('agent-1'))).not.toBe(id(agentGlyphSvg('agent-2')));
  });
});
