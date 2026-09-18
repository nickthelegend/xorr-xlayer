/**
 * AgentOrb.tsx — the agent's face.
 *
 * design.md §5:
 *   size 52 / 56 / 70 / 74 / 84 / 104 · border-radius 50%
 *   background radial-gradient(circle at 32% 26%, c1, c2 74%)
 *   optional bloom     0 14px 40px rgba(<c1>,.4)
 *   optional specular  white ellipse, ~28% width, blur 2–3px, top ~17%, left ~24%
 *   optional face      two 9×13 round-rect eyes at ~40% height, 16×7 smile arc
 *   optional badge     P&L chip at top −8 left −6, 10/700 upInk on up
 *   under it           name 12–12.5/600 white, status 10.5/600 — up Active/New, ink40 Paused
 *
 * §1: "the off-center origin is the specular highlight and must not move." So `cx`/`cy`
 * are constants here, not props.
 *
 * The CSS `circle at 32% 26%` with no explicit size ends at the *farthest corner* — from
 * (.32,.26) that is (1,1), at √(.68² + .74²) = 1.005 of the box. Hence `r="100.5%"`, and
 * the `c2` stop at .74 of that radius, exactly as CSS places it.
 *
 * Every dimension below is a fraction of `size`, measured off the 74px orb in the
 * prototype, so all six sizes are the same drawing rather than six hand-placed ones.
 *
 * `identity` draws the face from the agent's name instead (`agentGlyph`): eyes, a mouth and a
 * mark on the sphere, the same for that name on every screen. The orb — gradient, specular,
 * bloom — is untouched; without `identity` the face is §5's single design.
 *
 * ## `stage` — what the agent is doing (2026-09-17)
 *
 * animations.md's "If you add motion" sanctions two things and nothing else: a slow scale breathe on an
 * active agent's orb, and a single 250ms scale-in on a fill. `stage` is those two, plus the two states
 * between them, driven by **what the screen actually knows** — never by a timer. An orb that cycles
 * through a performance on a schedule is a loading spinner wearing a face: it says "something is
 * happening" while nothing is, which on a screen that moves money is a lie the animation tells.
 *
 *   thinking   scale 1 → 1.015, breathing, 3.6s        the agent is working something out
 *   decided    settles to rest and holds still, 250ms  it has something for you; the screen says what
 *   executing  opacity 1 → .72, breathing, 900ms       it is acting — the skeleton's "still coming" cadence
 *   filled     one 250ms scale-in from .94, then still it is done
 *
 * Two loops, two properties. Scale means *alive*, opacity means *in flight*; a second scale loop at a
 * different speed would read as the same state at a different frame rate. The stages are ordered but not
 * sequential — a screen may go straight from thinking to filled, and each stage draws itself from
 * wherever the last one was.
 *
 * **The motion is never the only carrier.** Every screen that passes a stage already says the same thing
 * in words, because a person with reduced motion on — where all of this collapses to a still orb — must
 * lose nothing. That is the rule the badge, the status word and the orb's face all follow here.
 */
import React from 'react';
import { Image } from 'expo-image';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  FeGaussianBlur,
  Filter,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import { agentGlyph, pathData, type GlyphShape } from '../design/agentGlyph';
import { timing, useReducedMotion } from './motion';
import { Placeholder } from './States';
import { Text, Value } from './Text';
import { colors, duration, orbBloom, radius, size as metrics, space, type Gradient } from './tokens';

/** The six sizes design.md §5 sanctions. */
export type OrbSize = 52 | 56 | 70 | 74 | 84 | 104;

export type OrbStatus = 'active' | 'new' | 'paused';

/**
 * What the agent is doing right now, as the screen knows it.
 *
 * Passed from real state — a request in flight, a proposal waiting, an executor's answer — and never
 * from a timer. See the choreography in this file's docblock.
 */
export type AgentStage = 'thinking' | 'decided' | 'executing' | 'filled';

export interface AgentOrbProps {
  gradient: Gradient;
  size?: OrbSize;
  /** `0 14px 40px rgba(c1,.4)` — the agent's own colour, not a black shadow. */
  bloom?: boolean;
  /** The white highlight. On by default; it is what makes the sphere read as a sphere. */
  specular?: boolean;
  /** Eyes and a smile. Off for asset marks, which reuse the same gradient recipe. */
  face?: boolean;
  /**
   * Whose face this is — the agent's name. With `face`, the eyes, mouth and marks are generated
   * from it by `agentGlyph`, so every agent is recognisably itself and the same name draws the
   * same face everywhere. Without it, the face is §5's one design.
   */
  identity?: string;
  /** A P&L chip pinned outside the top-left of the orb. Already formatted, with a sign. */
  badge?: string;
  /** Positive or negative P&L on the badge. */
  badgeTone?: 'up' | 'down';
  /** Name under the orb. */
  name?: string;
  /** Status word under the name. Green for active/new, `ink40` for paused. */
  status?: OrbStatus;
  /**
   * What the agent is doing, which the orb performs. Undefined is a still orb, and is the default —
   * a roster of twelve orbs all breathing at once is a screen that will not sit still to be read.
   */
  stage?: AgentStage;
  /** Overrides the status word. Defaults to Active / New / Paused. */
  statusLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/* Geometry, as fractions of the orb. Measured from the 74px orb in the prototype. */
const GRADIENT_CX = '32%';
const GRADIENT_CY = '26%';
const GRADIENT_R = '100.5%';
const GRADIENT_C2_STOP = 0.74;

const SPECULAR = { w: 0.28, h: 0.18, left: 0.24, top: 0.17, blur: 0.035 };
const EYE = { w: 9 / 74, h: 13 / 74, top: 30 / 74, left: 21 / 74 };
const SMILE = { w: 16 / 74, h: 7 / 74, bottom: 16 / 74 };
const BADGE_OFFSET = { top: -8, left: -6 };

/** The top of the breath. design.md's own suggestion: 1.5% — visible on a 104pt orb, invisible as a jump. */
const BREATH = 1.015;
/** How far the orb dims while it is acting. The skeleton's depth, for the same reason: it must not out-contrast its screen. */
const ACTING_DIM = 0.72;
/** Where a fill's single scale-in starts. */
const FILL_FROM = 0.94;

const STATUS_LABEL: Readonly<Record<OrbStatus, string>> = {
  active: 'Active',
  new: 'New',
  paused: 'Paused',
};

/**
 * One shape of a generated face, scaled from the glyph's 100-unit box to the orb.
 *
 * The glyph names two tones rather than colours, and they resolve here to tokens: white for the
 * face, black at low opacity for marks set into the sphere.
 */
function GlyphPart({ shape, unit }: { shape: GlyphShape; unit: number }) {
  const paint = shape.tone === 'ink' ? colors.ink : colors.bg;
  switch (shape.kind) {
    case 'rect':
      return (
        <Rect
          x={shape.x * unit}
          y={shape.y * unit}
          width={shape.w * unit}
          height={shape.h * unit}
          rx={shape.r * unit}
          fill={paint}
          opacity={shape.opacity}
        />
      );
    case 'circle':
      return (
        <Circle
          cx={shape.cx * unit}
          cy={shape.cy * unit}
          r={shape.r * unit}
          fill={paint}
          opacity={shape.opacity}
        />
      );
    case 'fill':
      return <Path d={pathData(shape.d, unit)} fill={paint} opacity={shape.opacity} />;
    case 'stroke':
      return (
        <Path
          d={pathData(shape.d, unit)}
          fill="none"
          stroke={paint}
          strokeWidth={shape.width * unit}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={shape.opacity}
        />
      );
  }
}

/**
 * The stage, drawn: a scale and an opacity for the orb to wear.
 *
 * Each stage restates BOTH values, so an orb arriving from any other stage lands somewhere defined
 * rather than keeping half of what it was doing — a `filled` orb still breathing from `thinking` was
 * the first version of this, and the pop was invisible underneath the loop. `cancelAnimation` before
 * each, because a `withRepeat` left running is not stopped by assigning the shared value.
 *
 * Under reduced motion the loops are not started at all and the rest collapse to instant state changes
 * (`timing`), so the orb simply rests where the stage puts it. `ReduceMotion.System` as well as the
 * flag, for the same reason `motion.ts` gives: `useReducedMotion` answers a beat after mount, and
 * reanimated can ask the OS itself as the animation starts.
 */
function useStageMotion(stage: AgentStage | undefined) {
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  const shade = useSharedValue(1);

  React.useEffect(() => {
    cancelAnimation(scale);
    cancelAnimation(shade);
    if (stage === undefined) {
      scale.set(1);
      shade.set(1);
      return;
    }
    if (stage === 'thinking') {
      shade.set(1);
      if (reduced) {
        scale.set(1);
        return;
      }
      scale.set(
        withRepeat(
          withTiming(BREATH, { ...timing(duration.breathe, reduced), reduceMotion: ReduceMotion.System }),
          -1,
          true,
        ),
      );
      return;
    }
    if (stage === 'executing') {
      scale.set(withTiming(1, { ...timing(duration.slow, reduced), reduceMotion: ReduceMotion.System }));
      if (reduced) {
        shade.set(1);
        return;
      }
      shade.set(
        withRepeat(
          withTiming(ACTING_DIM, { ...timing(duration.pulse, reduced), reduceMotion: ReduceMotion.System }),
          -1,
          true,
        ),
      );
      return;
    }
    shade.set(withTiming(1, { ...timing(duration.slow, reduced), reduceMotion: ReduceMotion.System }));
    // A fill arrives; a decision settles. Both end at rest, and neither loops.
    if (stage === 'filled') scale.set(FILL_FROM);
    scale.set(withTiming(1, { ...timing(duration.slow, reduced), reduceMotion: ReduceMotion.System }));
  }, [stage, reduced, scale, shade]);

  // Stopped with the component: a loop outliving its orb is a frame budget nobody is spending on anything.
  React.useEffect(
    () => () => {
      cancelAnimation(scale);
      cancelAnimation(shade);
    },
    [scale, shade],
  );

  return useAnimatedStyle(() => ({ opacity: shade.get(), transform: [{ scale: scale.get() }] }));
}

export function AgentOrb({
  gradient,
  size = 70,
  bloom = false,
  specular = true,
  face = false,
  identity,
  badge,
  badgeTone = 'up',
  name,
  status,
  statusLabel,
  stage,
  style,
  testID,
}: AgentOrbProps) {
  const staged = useStageMotion(stage);
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradientId = `orb-g-${uid}`;
  const blurId = `orb-b-${uid}`;

  const glyph = React.useMemo(
    () => (face && identity !== undefined ? agentGlyph(identity) : undefined),
    [face, identity],
  );
  const unit = size / 100;

  const eyeW = EYE.w * size;
  const eyeH = EYE.h * size;
  const eyeY = EYE.top * size;
  const eyeLeftX = EYE.left * size;
  const eyeRightX = size - EYE.left * size - eyeW;

  const smileW = SMILE.w * size;
  const smileH = SMILE.h * size;
  const smileX = (size - smileW) / 2;
  const smileY = size - SMILE.bottom * size - smileH;
  const smileR = Math.min(smileH, smileW / 2);

  const orb = (
    <Animated.View
      style={[
        bloom ? { borderRadius: radius.full, boxShadow: orbBloom(gradient.c1) } : null,
        // Still, and costing nothing, until a screen hands the orb a stage.
        staged,
      ]}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Defs>
          <RadialGradient
            id={gradientId}
            cx={GRADIENT_CX}
            cy={GRADIENT_CY}
            r={GRADIENT_R}
          >
            <Stop offset={0} stopColor={gradient.c1} />
            <Stop offset={GRADIENT_C2_STOP} stopColor={gradient.c2} />
          </RadialGradient>
          <Filter id={blurId} x="-30%" y="-30%" width="160%" height="160%">
            <FeGaussianBlur stdDeviation={SPECULAR.blur * size} />
          </Filter>
        </Defs>

        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${gradientId})`} />

        {/* Marks sit under the specular, so the highlight stays the brightest thing on the sphere. */}
        {glyph?.marks.map((shape, i) => <GlyphPart key={`mark-${i}`} shape={shape} unit={unit} />)}

        {specular && (
          <Ellipse
            cx={(SPECULAR.left + SPECULAR.w / 2) * size}
            cy={(SPECULAR.top + SPECULAR.h / 2) * size}
            rx={(SPECULAR.w / 2) * size}
            ry={(SPECULAR.h / 2) * size}
            fill={colors.ink}
            opacity={0.5}
            filter={`url(#${blurId})`}
          />
        )}

        {glyph
          ? glyph.face.map((shape, i) => <GlyphPart key={`face-${i}`} shape={shape} unit={unit} />)
          : face && (
              <>
                <Rect
                  x={eyeLeftX}
                  y={eyeY}
                  width={eyeW}
                  height={eyeH}
                  rx={eyeW / 2}
                  fill={colors.ink}
                />
                <Rect
                  x={eyeRightX}
                  y={eyeY}
                  width={eyeW}
                  height={eyeH}
                  rx={eyeW / 2}
                  fill={colors.ink}
                />
                <Path
                  d={
                    `M ${smileX} ${smileY}` +
                    ` H ${smileX + smileW}` +
                    ` A ${smileR} ${smileR} 0 0 1 ${smileX + smileW - smileR} ${smileY + smileH}` +
                    ` H ${smileX + smileR}` +
                    ` A ${smileR} ${smileR} 0 0 1 ${smileX} ${smileY}` +
                    ' Z'
                  }
                  fill={colors.ink}
                />
              </>
            )}
      </Svg>

      {badge !== undefined && (
        <View
          style={{
            position: 'absolute',
            top: BADGE_OFFSET.top,
            left: BADGE_OFFSET.left,
            paddingVertical: space.s2,
            paddingHorizontal: space.s6,
            borderRadius: radius.square,
            backgroundColor: badgeTone === 'up' ? colors.up : colors.down,
          }}
        >
          <Value variant="chipSm" color={badgeTone === 'up' ? colors.upInk : colors.ink}>
            {badge}
          </Value>
        </View>
      )}
    </Animated.View>
  );

  if (name === undefined && status === undefined) {
    return (
      <View testID={testID} style={style}>
        {orb}
      </View>
    );
  }

  return (
    <View testID={testID} style={[{ alignItems: 'center', gap: space.s8 }, style]}>
      {orb}
      {name !== undefined && (
        <Text variant="orbName">{name}</Text>
      )}
      {status !== undefined && (
        <Text
          variant="orbStatus"
          color={status === 'paused' ? colors.ink40 : colors.up}
        >
          {statusLabel ?? STATUS_LABEL[status]}
        </Text>
      )}
    </View>
  );
}

/**
 * Asset marks reuse the orb recipe at list-row scale — same gradient, no face, no bloom.
 * `data/markets.json` carries a `c1`/`c2` for every instrument.
 */
export function AssetMark({
  gradient,
  size = metrics.mark,
  uri,
  pending = false,
  style,
  testID,
}: {
  gradient: Gradient;
  size?: number;
  /**
   * The asset's real logo, from `/market/logos`. Null keeps the gradient.
   *
   * The gradient is not a placeholder to be ashamed of — it is the honest mark for an instrument
   * with no issuer and no token, which is every commodity, index and pre-IPO name in the list. It
   * also stays underneath a logo once it has drawn; while the logo is still on its way, the mark is a skeleton.
   */
  uri?: string | null;
  /**
   * The lookup is still in flight.
   *
   * Without this the mark had two states for three facts, and the gradient carried two of them:
   * "this instrument has no logo" and "the logo has not arrived". They look identical and mean
   * opposite things — one is final, one resolves a moment later — so a Markets list mid-load was
   * indistinguishable from one where every issuer had declined to have a mark. Same conflation the
   * dashes had, and the same fix: say which.
   */
  pending?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradientId = `mark-g-${uid}`;
  // A logo that 404s or is malformed falls back to the gradient rather than leaving a hole. Kept per address, so a mark
  // handed a different logo tries it rather than inheriting the last one's failure.
  const [failedUri, setFailedUri] = React.useState<string>();
  const [drawnUri, setDrawnUri] = React.useState<string>();
  const showLogo = !!uri && failedUri !== uri;
  /*
   * "Not yet" lasts until the image has drawn, not only until its address is known (2026-09-16).
   *
   * The gradient stood in while a logo downloaded, so a slow one read as an instrument with no mark: the conflation
   * `pending` exists to prevent, one step later. The block is one step lighter than the sheet a list sits on — drawn in
   * the sheet's own grey it was invisible there, and a row whose logo was still coming looked like a row with none.
   */
  const waiting = (pending && !showLogo) || (showLogo && drawnUri !== uri);

  return (
    <View testID={testID} style={[{ width: size, height: size }, style]}>
      {waiting ? (
        <Placeholder
          height={size}
          width={size}
          color={colors.switchOff}
          style={{ position: 'absolute', borderRadius: size / 2 }}
        />
      ) : (
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Defs>
            <RadialGradient id={gradientId} cx={GRADIENT_CX} cy={GRADIENT_CY} r={GRADIENT_R}>
              <Stop offset={0} stopColor={gradient.c1} />
              <Stop offset={GRADIENT_C2_STOP} stopColor={gradient.c2} />
            </RadialGradient>
          </Defs>
          <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${gradientId})`} />
        </Svg>
      )}
      {showLogo ? (
        <Image
          source={{ uri }}
          onLoad={() => setDrawnUri(uri ?? undefined)}
          onError={() => setFailedUri(uri ?? undefined)}
          // `contain` rather than `cover`: these are logos with their own padding and a mark
          // cropped to a circle loses the part that identifies it.
          contentFit="contain"
          transition={0}
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: size / 2,
          }}
        />
      ) : null}
    </View>
  );
}
