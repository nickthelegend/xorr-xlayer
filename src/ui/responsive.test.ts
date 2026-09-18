import { describe, expect, it } from 'vitest';
import { DESIGN_HEIGHT, DESIGN_WIDTH, hitTarget, scaleFont } from './responsive';
import { MIN_FONT_SIZE, type } from './type';

// The RN stub reports the design target (402x874), so scaling is a no-op there by construction.
describe('13.9 responsive rules', () => {
  it('the design target is the handoff’s', () => {
    expect(DESIGN_WIDTH).toBe(402);
    expect(DESIGN_HEIGHT).toBe(874);
  });

  it('never scales UP — the design is a maximum', () => {
    for (const size of [9.5, 14, 22, 46, 52]) {
      expect(scaleFont(size)).toBeLessThanOrEqual(size);
    }
  });

  it('at the design width nothing changes', () => {
    expect(scaleFont(46)).toBe(46);
    expect(scaleFont(9.5)).toBe(9.5);
  });

  it('hit targets never scale — 44pt is 44pt on every device', () => {
    expect(hitTarget(44)).toBe(44);
    expect(hitTarget(26)).toBe(26);
  });

  it('the floor it clamps to is the one design.md sets', () => {
    expect(MIN_FONT_SIZE).toBe(9.5);
    // Every role in the scale already sits at or above the floor, so scaling can only clamp.
    for (const [role, style] of Object.entries(type)) {
      const size = (style as { fontSize?: number }).fontSize ?? 0;
      expect(size, role).toBeGreaterThanOrEqual(MIN_FONT_SIZE);
    }
  });
});
