/**
 * Phase 13 audits — PLAN.md 13.2 / 13.3 / 13.4 / 13.6 / 13.7.
 *
 * These read the ACTUAL source of every screen and component. They are the mechanism that stops
 * the handoff's rules decaying as the app grows, which is the only way a rule survives contact
 * with a second contributor.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const APP = path.join(ROOT, 'app');
/** The design system. `src/design` was the layer it replaced; only the icon set and the
 *  identity gradients survive there, and neither is a component or a token. */
const UI = path.join(ROOT, 'src/ui');
/**
 * The chat. It is screen-shaped code that does not live under `app/` — the conversation is rendered
 * by both the `/bot` route and the tab-bar sheet, so it was extracted to a component. Scanning it
 * here keeps the accessibility, motion and voice rules over it; leaving it out would have made
 * "move it out of app/" a way to opt a surface out of its own audit.
 */
const CHAT = path.join(ROOT, 'src/chat');

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    // Test files are excluded: they QUOTE the patterns these rules forbid, in assertion
    // strings and comments, so scanning them makes every rule report itself as a violation.
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

/**
 * User-facing screens. `app/_dev/` is excluded on purpose: the fidelity harness and the component
 * gallery are DEVELOPER tools, and a gallery whose whole job is to show sample values would fail
 * the "no hardcoded money" rule for the exact reason it exists. The rules protect what a user
 * sees; they are not loosened for anything a user can reach.
 */
const screenFiles = walk(APP).filter((f) => !f.includes('_layout') && !f.includes(`${path.sep}_dev${path.sep}`));
const allFiles = [...screenFiles, ...walk(UI), ...walk(CHAT)];
const rel = (f: string) => path.relative(ROOT, f);

/**
 * Extract complete JSX opening tags for a component.
 *
 * A naive /<Tag[\s\S]*?>/ stops at the first ">", which in React Native is almost always the
 * one inside an inline `onPress={() => …}` arrow — so it silently reports every handler-bearing
 * component as unlabelled. This walks the tag and tracks brace depth instead.
 */
function openingTags(src: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b`, 'g');
  for (const m of src.matchAll(re)) {
    let i = m.index + m[0].length;
    let depth = 0;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

describe('13.6 motion audit — animations.md', () => {
  const animated = allFiles.filter((f) => /withTiming|withRepeat/.test(fs.readFileSync(f, 'utf8')));

  it('finds the animated surfaces', () => {
    expect(animated.length).toBeGreaterThan(4);
  });

  it('every duration comes from the DURATION scale — no magic numbers', () => {
    const offenders: string[] = [];
    for (const f of animated) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      // A literal ms value passed to withTiming is the failure mode we care about.
      for (const m of src.matchAll(/duration:\s*(\d+)/g)) {
        offenders.push(`${rel(f)} duration: ${m[1]}`);
      }
    }
    expect(offenders, `hardcoded durations:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no spring, bounce or overshoot anywhere — animations.md §4', () => {
    const offenders: string[] = [];
    for (const f of allFiles) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      if (/withSpring|withBounce|withDecay|Easing\.bounce|Easing\.elastic|Easing\.back/.test(src)) {
        offenders.push(rel(f));
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no custom cubic-bezier — the platform default is the only easing', () => {
    const offenders: string[] = [];
    for (const f of allFiles) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      if (/Easing\.bezier|cubic-bezier/.test(src)) offenders.push(rel(f));
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every animation respects reduced motion — animations.md §6', () => {
    const offenders: string[] = [];
    for (const f of animated) {
      const src = fs.readFileSync(f, 'utf8');
      // AgentOrb cancels its own animation under reduced motion instead of zeroing a duration.
      if (!/motionDuration|useReducedMotion|reduced/.test(src)) offenders.push(rel(f));
    }
    expect(offenders, `animate without a reduced-motion path:\n${offenders.join('\n')}`).toEqual([]);
  });

  /*
   * The policy changed on 2026-09-12: screens now arrive (see motion.ts). The rule that survives is
   * WHERE arrival motion is made — `<Rise>` and `<RollingNumber>` in src/ui, which honour reduced
   * motion — so a screen that reaches for reanimated's builders directly still fails here.
   */
  it('screens arrive only through <Rise> — never a raw entrance builder', () => {
    const offenders: string[] = [];
    for (const f of screenFiles) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      // `Layout` alone matched LayoutChangeEvent; only the animation APIs count.
      if (/entering=|exiting=|FadeIn|SlideIn|ZoomIn|LinearTransition|itemLayoutAnimation/.test(src)) {
        offenders.push(rel(f));
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('THE PRICE RULE: no price, delta or P&L value is ever animated', () => {
    // A screen may animate a bar or a marker; it may never wrap a price in an Animated.Text.
    const offenders: string[] = [];
    for (const f of allFiles) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      if (/Animated\.Text/.test(src)) offenders.push(`${rel(f)} uses Animated.Text`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  /*
   * TWO animated views, and the rule they both keep is that neither moves while you read the screen: the bar answers
   * the Messages drawer, and the mark under Home answers navigation. Nothing on the bar is ambient. A third would need
   * to make the same argument, which is why the count is pinned and not only the properties.
   */
  it('the tab bar moves only to answer the drawer and the selection — nothing on it is ambient', () => {
    const tabBar = stripComments(fs.readFileSync(path.join(UI, 'TabBar.tsx'), 'utf8'));
    // No loop and no spring: nothing on the bar breathes, and nothing overshoots.
    expect(tabBar).not.toMatch(/withRepeat|withSpring/);
    expect(tabBar.match(/<Animated\.View/g) ?? []).toHaveLength(2);
    // One property, driven by one input: down while the Messages drawer is up, back when it is not.
    expect(tabBar).toMatch(/withTiming\(hidden \? travel : 0/);
    expect(tabBar).toMatch(/transform: \[\{ translateY: y\.value \}\]/);
    // And one property for the mark under the open place: it grows in and shrinks away, it does not slide or fade.
    expect(tabBar).toMatch(/withTiming\(selected \? 1 : MARK_FROM/);
    expect(tabBar).toMatch(/transform: \[\{ scale: mark\.value \}\]/);
  });

  it('arrival motion honours reduced motion — the builder and the wrapper both ask', () => {
    const motion = stripComments(fs.readFileSync(path.join(UI, 'motion.ts'), 'utf8'));
    const rise = stripComments(fs.readFileSync(path.join(UI, 'Rise.tsx'), 'utf8'));
    expect(motion).toMatch(/ReduceMotion\.System/);
    expect(rise).toMatch(/useReducedMotion/);
  });
});

describe('13.7 formatting audit — state.md', () => {
  it('no screen calls toFixed on money — toLocaleString or nothing', () => {
    const offenders: string[] = [];
    for (const f of screenFiles) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      for (const m of src.matchAll(/toFixed\(/g)) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${rel(f)}:${line}`);
      }
    }
    // Sharpe (1.4) is a ratio, not money; it is the only sanctioned toFixed in the screen layer.
    const real = offenders.filter((o) => !o.includes('backtest.tsx'));
    expect(real, `toFixed in the screen layer:\n${real.join('\n')}`).toEqual([]);
  });

  it('no ASCII hyphen in a rendered negative — U+2212 only', () => {
    const offenders: string[] = [];
    for (const f of [...screenFiles, ...walk(path.join(ROOT, 'src/state'))]) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      for (const m of src.matchAll(/'[^']*-\$\d/g)) offenders.push(`${rel(f)} ${m[0]}`);
      for (const m of src.matchAll(/"[^"]*-\$\d/g)) offenders.push(`${rel(f)} ${m[0]}`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('money always flows through the format module', () => {
    const offenders: string[] = [];
    for (const f of screenFiles) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      // A literal dollar figure with a decimal is a value that dodged the formatter.
      for (const m of src.matchAll(/['"`]\$\d+\.\d{2}['"`]/g)) offenders.push(`${rel(f)} ${m[0]}`);
    }
    expect(offenders, `hardcoded money:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('13.2 / 13.3 accessibility', () => {
  it('every Pressable declares a role and a label', () => {
    const offenders: string[] = [];
    for (const f of allFiles) {
      // `Press` is the ONE place RN's `Pressable` is allowed bare: it is the primitive that
      // wraps it, and it forwards whatever accessibility props its caller passes.
      if (rel(f) === path.join('src', 'ui', 'Press.tsx')) continue;
      const src = fs.readFileSync(f, 'utf8');
      for (const p of openingTags(src, 'Pressable')) {
        if (!/accessibilityRole/.test(p) || !/accessibilityLabel|accessibilityState/.test(p)) {
          offenders.push(`${rel(f)}: ${p.slice(0, 90).replace(/\s+/g, ' ')}…`);
        }
      }
    }
    expect(offenders, `unlabelled Pressables:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every TextInput has a label', () => {
    const offenders: string[] = [];
    for (const f of allFiles) {
      const src = fs.readFileSync(f, 'utf8');
      for (const t of openingTags(src, 'TextInput')) {
        if (!/accessibilityLabel/.test(t)) offenders.push(rel(f));
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('small controls expand their touch area rather than growing', () => {
    // design.md §7: "Steppers are 26px visually — expand the touch area, don't grow the circle."
    // `Press` is where the growth happens, so the stepper only has to declare its drawn
    // size and let the primitive do it — which is the point of having the primitive.
    const stepper = fs.readFileSync(path.join(UI, 'Stepper.tsx'), 'utf8');
    expect(stepper).toMatch(/hitHeight|hitWidth/);
    const press = fs.readFileSync(path.join(UI, 'Press.tsx'), 'utf8');
    expect(press).toContain('hitSlop');
    expect(press).toMatch(/size\.hit/);
    const tokens = fs.readFileSync(path.join(UI, 'tokens.ts'), 'utf8');
    expect(tokens).toMatch(/hit:\s*44/);
    expect(tokens).toMatch(/stepperCircle:\s*26/);
  });

  it('P&L colour is always paired with a sign or a word', () => {
    // The formatters guarantee this: percent() and signedMoney() always emit + or U+2212.
    const format = fs.readFileSync(path.join(ROOT, 'src/format/index.ts'), 'utf8');
    expect(format).toContain('explicitSign');
    expect(format).toContain('MINUS');
  });
});

describe('13.1 layout law — design.md §4', () => {
  it('no screen puts a bare flex:1 spacer before its footer', () => {
    const offenders: string[] = [];
    for (const f of screenFiles) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      // A self-closing View whose only job is flex:1 is the exact bug design.md warns about.
      if (/<View\s+style=\{\{\s*flex:\s*1\s*\}\}\s*\/>/.test(src)) offenders.push(rel(f));
    }
    expect(offenders, `trailing spacers:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('screens use the Screen shell rather than rolling their own', () => {
    const offenders: string[] = [];
    for (const f of screenFiles) {
      const src = fs.readFileSync(f, 'utf8');
      // `src/ui` is the design system; `src/design` is the layer it replaces and still holds
      // the icon set and the identity gradients. A screen importing from NEITHER has rolled
      // its own shell, which is the thing worth catching. This tightens to `@/ui` alone once
      // nothing imports the old component set.
      if (!/from '@\/ui'|from '@\/design/.test(src)) offenders.push(rel(f));
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('copy.md voice rules', () => {
  it('no emoji anywhere in the app', () => {
    const offenders: string[] = [];
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const f of [...allFiles, ...walk(path.join(ROOT, 'src/legal'))]) {
      const src = fs.readFileSync(f, 'utf8');
      if (EMOJI.test(src)) offenders.push(rel(f));
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no exclamation marks in user-facing strings', () => {
    const offenders: string[] = [];
    for (const f of [...screenFiles, ...walk(path.join(ROOT, 'src/legal'))]) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      for (const m of src.matchAll(/['"`][^'"`\n]*!['"`]/g)) {
        if (!/!==|!=/.test(m[0])) offenders.push(`${rel(f)} ${m[0]}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every performance surface carries its disclaimer', () => {
    const roster = fs.readFileSync(path.join(APP, 'bot/roster.tsx'), 'utf8');
    expect(roster).toContain('Past performance of a strategy says nothing about tomorrow');
    const backtest = fs.readFileSync(path.join(APP, 'bot/[id]/backtest.tsx'), 'utf8');
    expect(backtest).toContain('Nothing here is a promise');
    const intro = fs.readFileSync(path.join(APP, 'bot/[id]/intro.tsx'), 'utf8');
    expect(intro).toContain('All agents can make mistakes');
  });
});

describe('13.9 device matrix — every screen has an answer for a short device', () => {
  it('screens either scroll or fit within the shortest supported viewport', () => {
    // iPhone SE is 667 tall; the design is 874. A screen with more than a header, a chart and a
    // footer must be able to scroll, or its content is unreachable on a small phone.
    const offenders: string[] = [];
    for (const f of screenFiles) {
      const src = fs.readFileSync(f, 'utf8');
      const scrolls = /ScrollView|FlashList|FlatList|KeyboardAvoidingView/.test(src);
      /*
       * A cheap proxy for "tall", widened to include the cards `/delegate` is built from.
       *
       * It counted five component names, none of which that screen uses, so it scored three and
       * passed — while measuring 865pt of content in a 667pt viewport with `body` at
       * `overflow: hidden`. Unreachable on that device: the risk warning, and the sentence saying
       * the wallet is about to ask for — one per tradable token, then the grant. On the consent screen.
       *
       * Counting `<Text>` too was tried and over-flags badly: eight screens tripped it that
       * measure FITS in a real 375×667 browser, because a chart or a list inside `Fill` absorbs
       * the height. A static count cannot tell intrinsic height from flex-anchored height, so
       * this stays a warning and the measured cases are pinned separately below.
       */
      const blocks = (src.match(
        /<(SheetCard|Row|NoteStrip|Segmented|Stepper|ConsequenceCard|Party|Pill)\b/g,
      ) ?? []).length;
      if (!scrolls && blocks > 6) offenders.push(`${rel(f)} (${blocks} blocks, no scroll)`);
    }
    expect(offenders, `unscrollable tall screens:\n${offenders.join('\n')}`).toEqual([]);
  });

  /*
   * The three screens measured overflowing in a real browser at 375×667 — an iPhone SE, the
   * shortest device the design supports. A static block count cannot predict runtime height, so
   * what was actually observed is pinned here instead of inferred:
   *
   *   /delegate  865pt of content, body overflow:hidden — risk warning and the signature-count
   *              sentence both unreachable
   *   /fund      368pt over, three elements hidden including the ADDRESS, on the screen whose
   *              only job is handing someone an address
   *   /perp      87pt over, two elements hidden — on a leverage screen, which means the
   *              liquidation price and the margin warning
   */
  it('the screens measured overflowing on a short device can scroll', () => {
    for (const f of ['(onboarding)/delegate.tsx', '(onboarding)/fund.tsx', 'perp/[symbol].tsx']) {
      const src = fs.readFileSync(path.join(APP, f), 'utf8');
      expect(/ScrollView|FlashList|FlatList/.test(src), `${f} must scroll — measured overflowing at 375x667`).toBe(true);
    }
  });

  it('no screen hardcodes the design width or height', () => {
    const offenders: string[] = [];
    for (const f of screenFiles) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      if (/width:\s*402|height:\s*874/.test(src)) offenders.push(rel(f));
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});


describe('the dev surfaces are developer-only', () => {
  it('no user-facing screen links to app/_dev', () => {
    const offenders: string[] = [];
    for (const f of screenFiles) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      if (/_dev/.test(src)) offenders.push(rel(f));
    }
    expect(offenders, `_dev reachable from:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('but they exist, because PLAN.md 1.16 and 2.8 require them', () => {
    expect(fs.existsSync(path.join(APP, '_dev/fidelity.tsx'))).toBe(true);
    // The gallery is `_dev/ui.tsx` — every `src/ui` primitive in every state. It replaced
    // `_dev/components.tsx`, which showed the component set that no longer exists.
    expect(fs.existsSync(path.join(APP, '_dev/ui.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(APP, '_dev/ui-edge.tsx'))).toBe(true);
  });
});
