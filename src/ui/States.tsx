/**
 * States.tsx — loading, error and empty. PLAN.md 10.11 [G17].
 *
 * The height match matters more than it looks. A loading state shorter than the row it
 * stands in for makes the list jump when data lands, and a jump on a price list reads as a
 * market move.
 *
 * **On the pulse.** These were static blocks, on the reading that animations.md §5 bans entrance
 * animations and staggered list reveals and therefore "rules out the usual shimmer skeleton". The
 * ban is real and the conclusion was too broad: what §5 forbids is content ARRIVING with a flourish
 * — a fade-in, a slide, a stagger down a list — because that dramatises data appearing. A uniform
 * opacity pulse on a block that is not content does none of that. It says one thing, which a static
 * grey block cannot: *still coming*. That is exactly the distinction this app makes everywhere else
 * between "nothing" and "not yet", and a skeleton indistinguishable from an empty row is the same
 * conflation in another costume.
 *
 * It is off under reduced motion, where the block is simply grey.
 */
import React, { useEffect } from 'react';
import { View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
/*
 * The two imports this layer takes from outside itself. Both are pure by construction — `apiError.ts` has
 * its own docblock about being split out of `api.ts` to stay free of any runtime, and `failures.ts` is a
 * lookup table over what that module produces — so this is string functions, not the data layer's fetching
 * machinery. The alternative was resolving the text and the retry at all 51 call sites.
 */
import { NotSignedIn, wasReplayed } from '@/data/apiError';
import { classify, waitSentence } from '@/data/failures';
import { replayNote } from '@/markets/placed';
import { Button } from './Button';
import { emptyList, type EmptyListKey } from './emptyActions';
import { Press } from './Press';
import { SignInPrompt } from './SignIn';
import { Text } from './Text';
import { duration, timing, useReducedMotion } from './motion';
import { chart, colors, divider, radius, size, space } from './tokens';

/** How far the pulse dims. Shallow on purpose — a skeleton should not compete with content. */
const PULSE_TO = 0.45;

/**
 * A placeholder block that breathes.
 *
 * `pulse={false}` for the rare case where one sits next to real content and the movement would
 * pull the eye off it.
 */
export function Placeholder({
  height,
  width = '100%',
  pulse = true,
  color = colors.surfaceAlt,
  style,
  testID,
}: {
  height: number;
  width?: DimensionValue;
  pulse?: boolean;
  /** The block's grey: the surface a list sits on by default. A block drawn on that surface itself passes a lighter one. */
  color?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (!pulse || reduced) {
      opacity.value = 1;
      return;
    }
    // `true` reverses, so it breathes rather than snapping back to full at the loop boundary.
    opacity.value = withRepeat(withTiming(PULSE_TO, timing(duration.pulse, reduced)), -1, true);
  }, [pulse, reduced, opacity]);

  const anim = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      testID={testID}
      accessibilityLabel="Loading"
      style={[
        { height, width, borderRadius: radius.square, backgroundColor: color },
        style,
        anim,
      ]}
    />
  );
}

/**
 * Rows-shaped loading state, so the list does not change height when data lands.
 *
 * `spark` reserves the sparkline's width as well. A market row is mark · name · **glyph** · price,
 * and a skeleton that omitted the glyph left the price block to slide left when the series
 * arrived — on a price column, which is the one place in the app nothing is allowed to move
 * without meaning it.
 *
 * The widths vary per row rather than sitting in a perfect column. Identical rows read as a
 * rendered table that has finished; slightly ragged ones read as content still filling in, which
 * is what is actually true.
 */
const NAME_W = ['46%', '38%', '52%', '42%'] as const;
const SUB_W = ['30%', '26%', '34%', '28%'] as const;

export function LoadingRows({
  count = 6,
  height = size.rowLg,
  spark = false,
  testID,
}: {
  count?: number;
  height?: number;
  spark?: boolean;
  testID?: string;
}) {
  return (
    <View testID={testID} accessibilityLabel="Loading">
      {Array.from({ length: count }, (_, i) => (
        <View
          key={i}
          style={[
            { height, flexDirection: 'row', alignItems: 'center', gap: space.s12 },
            divider,
          ]}
        >
          <Placeholder height={size.mark} width={size.mark} style={{ borderRadius: radius.full }} />
          <View style={{ flex: 1, gap: space.s6 }}>
            <Placeholder height={12} width={NAME_W[i % NAME_W.length]} />
            <Placeholder height={10} width={SUB_W[i % SUB_W.length]} />
          </View>
          {spark ? (
            <Placeholder height={chart.spark.height * 0.6} width={chart.spark.width} />
          ) : null}
          <View style={{ alignItems: 'flex-end', gap: space.s6 }}>
            <Placeholder height={12} width={64} />
            <Placeholder height={10} width={44} />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * A failure the user can act on.
 *
 * The message is the real one off the error — a generic "something went wrong" hides which of the executor,
 * the price feed or the chain is down — and what is offered beside it comes from `classify` (`failures.ts`)
 * rather than from the status code alone.
 *
 * Three things that table decides which this could not:
 *
 *   - **Whether a retry is honest.** `isRetryable` read the status, so every 409 was permanent and every 503
 *     was worth repeating. The executor's `warming` is a 503 that answers in seconds and its
 *     `request_in_flight` is a 409 that must NOT be repeated, and neither is visible from a number.
 *   - **When.** A 429 and a warming 503 both carry `retry-after`. A retry offered without it is offered for
 *     right now, which against a limiter turns one refusal into six.
 *   - **Where the fix is.** A missing permission is fixed on Safety and a spent cap on Limits. A sentence
 *     naming a problem with no route to its fix is half an error.
 */
export function ErrorState({
  error,
  onRetry,
  testID,
}: {
  error: Error;
  onRetry?: () => void;
  testID?: string;
}) {
  const router = useRouter();
  // Signed out is not a failure — nothing was asked — so it gets a way in, not a retry. See SignIn.tsx.
  if (error instanceof NotSignedIn) return <SignInPrompt testID={testID} />;
  const failure = classify(error);
  return (
    <View
      testID={testID}
      style={{ paddingVertical: space.s30, gap: space.s14, alignItems: 'center' }}
      accessibilityLiveRegion="polite"
    >
      <Text variant="rowPrimary">That did not load.</Text>
      <Text variant="secondary" align="center">
        {failure.message}
      </Text>
      {/*
        How long the executor asked for, where it said. "Try again" under a limiter that has just asked for
        forty seconds is an invitation to spend the next forty seconds being refused.
      */}
      {failure.retryAfterSec !== undefined && failure.retryAfterSec > 0 ? (
        <Text variant="footnote" color={colors.ink55} align="center">
          {waitSentence(failure.retryAfterSec)}
        </Text>
      ) : null}
      {/*
        The request's reference, under a server fault or a timeout (FEATURES.md #90): the first eight characters the
        executor's own log lines for it begin with. Quiet, and selectable, because its only job is to be copied into a
        report.
      */}
      {failure.ref ? (
        <Text variant="footnote" color={colors.ink55} selectable>
          {`Ref ${failure.ref}`}
        </Text>
      ) : null}
      {/*
        A retry is offered only where repeating the request could answer differently. Under a
        permanent refusal the button is worse than nothing — it invites someone to press it until
        they give up on the app rather than on the request.
      */}
      {/*
        `testID` on the retry is load-bearing, not a test hook: it is what keys the press guard.
        Retrying unmounts this component while the request is in flight, so a per-instance lock
        dies with it and the second half of a double-tap fires a second request. Measured on the
        deployed app — two `/limits` calls 11ms apart against one for a single click.
      */}
      {onRetry && failure.retryable ? (
        <Button label="Try again" variant="ghost" onPress={onRetry} testID="error-retry" />
      ) : null}
      {/* And the screen that fixes it, where the failure has one. A refusal with a route out is not a dead end. */}
      {failure.fix ? (
        <Press
          onPress={() => router.push(failure.fix!.href)}
          accessibilityRole="button"
          accessibilityLabel={failure.fix.label}
          hitHeight={size.hit}
        >
          <Text variant="control">{failure.fix.label} ›</Text>
        </Press>
      ) : null}
    </View>
  );
}

/**
 * An empty list, with somewhere to go.
 *
 * Several screens ended at "Nothing here yet." — true, and a dead end. An empty state is the
 * first thing a new user sees on a screen, so it is the one place where telling them what to
 * do next is worth more than anything else that could occupy the space.
 *
 * The action is optional because some lists genuinely have no next step: an audit trail with
 * nothing in it is waiting on the bot, not on the user.
 */
export function EmptyState({
  text,
  actionLabel,
  onAction,
  testID,
}: {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      style={{ paddingVertical: space.s30, alignItems: 'center', gap: space.s12 }}
    >
      <Text variant="body" color={colors.ink55} align="center">
        {text}
      </Text>
      {actionLabel && onAction ? (
        <Press
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          hitHeight={size.hit}
        >
          <Text variant="control">{actionLabel} ›</Text>
        </Press>
      ) : null}
    </View>
  );
}

/**
 * One of the app's lists, empty, with the exit written for it in `emptyActions.ts`.
 *
 * The screens were each writing their own sentence and their own `router.push`, which is how three of them
 * ended at "Nothing here yet." with no action at all. A screen names the list; where that list's exit goes is
 * one table, and one test checks every route in it still exists.
 *
 * `text` overrides the sentence for the cases where the screen knows something the table cannot — a filter
 * that matched nothing is not an empty trail — and the action stays, because it is still the right next thing.
 */
export function EmptyList({
  list,
  text,
  testID,
}: {
  list: EmptyListKey;
  text?: string;
  testID?: string;
}) {
  const router = useRouter();
  const copy = emptyList(list);
  return (
    <EmptyState
      text={text ?? copy.text}
      actionLabel={copy.actionLabel}
      onAction={() => router.push(copy.href)}
      testID={testID}
    />
  );
}

/**
 * A failure from something the user DID, said where they did it.
 *
 * `ErrorState` is for a read that did not land: it replaces the content, because there is none. This is for a
 * write that was refused — an order, a strategy, a grant — where the screen is still full of the thing that
 * was being attempted and the failure belongs beside the button, not over the top of it.
 *
 * Every screen with a write was rendering `errorText(e)` into a red footnote, which is the sentence and
 * nothing else: no way to tell a refusal that will stand from one worth repeating, and no route to the fix
 * even where the failure names one. A daily cap spent, said over a green Buy button, with no way to Limits.
 */
export function FailureNote({
  error,
  onRetry,
  light = false,
  style,
  testID,
}: {
  error: unknown;
  /** Offered only where the failure says repeating it could answer differently. */
  onRetry?: () => void;
  /** On a white sheet — the order ticket and the strategy setups. */
  light?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const router = useRouter();
  const failure = classify(error);
  const tone = light ? colors.candleDown : colors.down;
  const quiet = light ? colors.sheet.muted : colors.ink55;
  /*
   * A refusal the executor had already answered under this key.
   *
   * It is stored and replayed exactly as a fill is, so a second tap gets the first attempt's refusal back —
   * and without saying so, that reads as a second, separate rejection of a second try.
   */
  const replay = replayNote(wasReplayed(error));
  return (
    <View
      testID={testID}
      style={[{ gap: space.s6, alignItems: 'center' }, style]}
      // Announced when it appears: the refusal is the answer to the button that was just pressed.
      accessibilityLiveRegion="polite"
    >
      <Text variant="footnote" color={tone} align="center">
        {failure.message}
      </Text>
      {replay ? (
        <Text variant="footnote" color={quiet} align="center">
          {replay}
        </Text>
      ) : null}
      {failure.retryAfterSec !== undefined && failure.retryAfterSec > 0 ? (
        <Text variant="footnote" color={quiet} align="center">
          {waitSentence(failure.retryAfterSec)}
        </Text>
      ) : null}
      {failure.ref ? (
        <Text variant="footnote" color={quiet} selectable>
          {`Ref ${failure.ref}`}
        </Text>
      ) : null}
      {failure.fix ? (
        <Press
          onPress={() => router.push(failure.fix!.href)}
          accessibilityRole="button"
          accessibilityLabel={failure.fix.label}
          hitHeight={size.hit}
        >
          <Text variant="control" color={light ? colors.sheet.ink : undefined}>
            {failure.fix.label} ›
          </Text>
        </Press>
      ) : null}
      {onRetry && failure.retryable ? (
        <Press onPress={onRetry} accessibilityRole="button" accessibilityLabel="Try again" hitHeight={size.hit}>
          <Text variant="control" color={light ? colors.sheet.ink : undefined}>
            Try again ›
          </Text>
        </Press>
      ) : null}
    </View>
  );
}
