/**
 * Is the executor reachable, and say so when it is not.
 *
 * The app assumed it always was. Every screen reads through `api`, every failure is caught per
 * screen, and each one renders its own local emptiness: no positions, no strategies, no history,
 * "nothing has settled yet". Individually those are honest sentences. Together, on a dropped
 * connection, they compose into a confident and completely false picture — an account with
 * nothing in it — and the user has no way to tell that from the truth.
 *
 * That is worse here than in most apps. Someone opening this on a bad connection is checking
 * whether a bot has been trading their money, and "nothing happened" is exactly the answer they
 * are afraid of.
 *
 * The banner is deliberately not a modal and does not block anything. Cached screens still work,
 * the kill switch is signed on chain rather than through us and works with the executor entirely
 * down, and covering the app with a dialog would take that away at the moment it matters most.
 */
import React, { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { Press, Text, colors, radius, signIn, size, space } from '@/ui';
import { useNow } from '@/state/useNow';
import { executorHealth } from '@/data/health';
import { CHAIN_KEY, chainMoney, chainSentenceName } from '@/chain';
import { compareChains, type ChainMatch } from './chainMatch';
import { openBreakers, throttleBanner, type ThrottleState } from './throttle';
import { reconnectBanner, retryDelayMs, type ReconnectState } from './reconnect';
import {
  SESSION_ENDED_DETAIL,
  SESSION_ENDED_TITLE,
  sessionEndedAt,
  subscribeSessionEnded,
} from '@/auth/reauth';
import { useThrottle } from './throttleStore';
import { ChainMismatchScreen } from './ChainMismatch';

/*
 * The two banners that carry a control, and why they need saying twice.
 *
 * Both were drawn as a plain panel, which takes every touch that lands on it — so the promise in their
 * comments, "the banner blocks nothing", was not true: in the browser the "Back online" notice sat over the
 * order ticket's Buy button for its eight seconds, and a tap there did nothing at all. `box-none` lets touches
 * through the panel to whatever is underneath, and the sentences opt out entirely, so the only thing on the
 * banner that answers a tap is the control that is meant to.
 */
const PASS_THROUGH_PANEL = {
  pointerEvents: 'box-none',
  position: 'absolute',
  left: space.s16,
  right: space.s16,
  bottom: space.s26,
  backgroundColor: colors.surfaceAlt,
  borderRadius: radius.card,
  paddingHorizontal: space.s16,
  paddingVertical: space.s12,
  gap: space.s4,
} as const;
const SENTENCES = { pointerEvents: 'none', gap: space.s4 } as const;

/** While up — a heartbeat, not a poll. While down, `retryDelayMs` backs off from two seconds. */
const HEARTBEAT_MS = 30_000;

const ReachabilityContext = createContext<boolean>(true);

/** True when the executor answered its health check most recently. */
export function useExecutorReachable(): boolean {
  return useContext(ReachabilityContext);
}

export function ReachabilityProvider({ children }: { children: React.ReactNode }) {
  const [reachable, setReachable] = useState(true);
  /*
   * How the reconnection is going, so the banner can show it.
   *
   * The banner used to be true and inert — "Can't reach xorr" with nothing moving, while a health
   * check was in fact going out every few seconds. Someone with no sign of activity cannot tell a
   * dropped connection from a broken app, and the difference decides whether they wait or start
   * unwinding positions by hand.
   */
  const [recon, setRecon] = useState<ReconnectState>({
    reachable: true,
    downSince: null,
    attempts: 0,
    nextAttemptAt: null,
    recoveredAt: null,
  });
  /*
   * Whether the executor serves the chain this build signs on, from the same heartbeat.
   *
   * Starts `unknown` rather than `match`: the app has not asked yet, and starting at a verdict it has not
   * earned is how a check like this ends up being decorative. `unknown` renders exactly as `match` does.
   */
  const [chain, setChain] = useState<ChainMatch>({ state: 'unknown' });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Bumped by the mismatch screen's recheck, which restarts the heartbeat rather than waiting out its interval. */
  const [askedAgain, setAskedAgain] = useState(0);

  useEffect(() => {
    let alive = true;
    /*
     * The failure count the TIMER reads, kept beside the state the banner reads.
     *
     * `setRecon` is asynchronous, so scheduling the next check from `recon.attempts` would always
     * use the previous render's number and the backoff would lag one step behind reality.
     */
    let failures = 0;

    const check = async () => {
      // A check is in flight: no countdown to show, and no retry to offer that would do anything.
      setRecon((prev) => (prev.nextAttemptAt === null ? prev : { ...prev, nextAttemptAt: null }));
      // The request itself lives in the data layer, where network access belongs.
      const beat = await executorHealth();
      if (!alive) return;
      setReachable(beat.reachable);

      /*
       * The attempt count, the outage's start and the moment of recovery, all from the heartbeat
       * that is really running. Nothing here invents a recovery or a retry that did not happen.
       */
      setRecon((prev) => {
        const attempts = beat.reachable ? 0 : prev.attempts + 1;
        const delay = beat.reachable ? HEARTBEAT_MS : retryDelayMs(attempts);
        return {
          reachable: beat.reachable,
          downSince: beat.reachable ? null : (prev.downSince ?? Date.now()),
          attempts,
          nextAttemptAt: Date.now() + delay,
          // Only on the edge from down to up, so the notice is about a real reconnection.
          recoveredAt: beat.reachable && !prev.reachable ? Date.now() : prev.recoveredAt,
        };
      });
      // Which upstreams the executor is routing around right now, from the report it already answers with.
      useThrottle.getState().reportBreakers(beat.breakers);
      setChain(
        compareChains({
          app: CHAIN_KEY,
          server: beat.chain,
          appName: chainSentenceName,
          appMoney: chainMoney,
          // The executor's own word for its money is not on `/health`, so it is left unsaid rather than
          // guessed — `compareChains` reads an unsaid one as real, which is the safe direction.
        }),
      );
      timer.current = setTimeout(check, beat.reachable ? HEARTBEAT_MS : retryDelayMs(failures + 1));
      if (!beat.reachable) failures += 1;
      else failures = 0;
    };

    void check();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [askedAgain]);

  /*
   * A mismatch replaces the app rather than sitting over it.
   *
   * Every other failure in this provider is a banner, deliberately: cached screens still work and the kill
   * switch is signed on chain, so covering the app would take that away at the moment it matters. A chain
   * mismatch is the one case where that reasoning inverts — the kill switch would be signed on the wrong
   * chain too, and there is no screen whose numbers mean anything. Nothing here is worth keeping reachable.
   */
  if (chain.state === 'mismatch')
    return <ChainMismatchScreen mismatch={chain} onRecheck={() => setAskedAgain((n) => n + 1)} />;

  return (
    <ReachabilityContext.Provider value={reachable}>
      {children}
      {/*
        One banner at a time, in order of how much it takes away.

        Unreachable first: nothing is loading at all, and a sentence about a throttle would be about a
        smaller problem than the one in front of the reader.
      */}
      <BottomBanner state={recon} onRetryNow={() => setAskedAgain((n) => n + 1)} />
    </ReachabilityContext.Provider>
  );
}

/**
 * The connection, while it is not there and just after it comes back.
 *
 * What it says matters more than that it appears. "Offline" alone would leave the reader to guess
 * what is still true, and the two facts they actually need are that their money is untouched and
 * that stopping the bot does not go through us. Both are properties of the design rather than
 * reassurances, which is why they can be stated flatly.
 *
 * It also shows the retry that is genuinely happening. The previous banner was inert, and a static
 * failure message reads as a verdict — as though the app had given up — when a health check is in
 * fact going out every few seconds.
 *
 * Still not a modal and still blocks nothing. Cached screens work, the kill switch is signed on
 * chain rather than through us and works with the executor entirely down, and covering the app
 * would take that away at the moment it matters most. Only the controls accept touches; the panel
 * itself does not, so nothing underneath becomes unreachable.
 */
/**
 * The one banner at the bottom of the app, and which of them it is.
 *
 * They share a slot — both are absolutely positioned above the same edge — so this has to be one
 * choice rather than two independent conditions, or a recovery notice and a rate limit would draw
 * on top of each other.
 *
 * The connection outranks a throttle: while it is down nothing is loading at all, and a sentence
 * about being rate-limited would be about a smaller problem than the one in front of the reader.
 *
 * The clock lives here, once. A second while a countdown is running, a minute otherwise — the
 * number in the sentence is the point of the sentence, and a countdown that does not count looks
 * like a frozen app rather than a waiting one. It also means the recovery notice expiring
 * re-renders this component, which is what hands the slot back to the throttle banner.
 */
function BottomBanner({
  state,
  onRetryNow,
}: {
  state: ReconnectState;
  onRetryNow: () => void;
}) {
  const now = useNow(state.reachable ? 60_000 : 1_000);

  /*
   * A dead session outranks both.
   *
   * Nothing authenticated will load at all until they sign in, so a sentence about a rate limit or
   * a countdown to the next health check would be about a smaller problem — and the connection may
   * be perfectly fine, which makes "can't reach xorr" actively wrong.
   */
  const endedAt = useSyncExternalStore(subscribeSessionEnded, sessionEndedAt, sessionEndedAt);
  if (endedAt !== null) return <SessionEndedBanner />;

  const banner = reconnectBanner(state, now);
  if (!banner) return <ThrottleBanner />;

  return (
    <View style={PASS_THROUGH_PANEL} accessibilityLiveRegion="polite">
      <View style={SENTENCES}>
        <Text variant="rowPrimary" color={banner.tone === 'down' ? colors.down : colors.ink}>
          {banner.title}
        </Text>
        <Text variant="footnote" color={colors.ink40}>
          {banner.detail}
        </Text>
      </View>
      {/*
        The only touchable part. The panel itself takes no touches, so nothing underneath becomes
        unreachable — the banner blocks nothing, which is the whole reason it is not a modal.

        Both labels run the same recheck: down, it is "try now"; back, it re-reads so the screens
        behind stop showing the outage's emptiness.
      */}
      {banner.retryable || banner.tone === 'back' ? (
        <Press
          onPress={onRetryNow}
          accessibilityRole="button"
          accessibilityLabel={
            banner.tone === 'back' ? 'Check the connection again' : 'Try to reach xorr now'
          }
          hitHeight={size.hit}
          style={{ alignSelf: 'flex-start' }}
        >
          <Text variant="footnote" color={colors.ink}>
            {banner.tone === 'back' ? 'Check again ›' : 'Try now ›'}
          </Text>
        </Press>
      ) : null}
    </View>
  );
}

/**
 * Being rate limited, or an upstream being routed around.
 *
 * Same shape as the offline banner and for the same reason: it does not block anything. Both of these are
 * temporary, neither is the user's fault, and neither is worth taking the app away over — a throttle that
 * covered the screen would be a worse outage than the throttle.
 *
 * It re-renders on a timer while one is live, because the sentence carries a number of seconds and the whole
 * point of that number is that it goes down. `useNow` is the app's existing clock for exactly this.
 */
function ThrottleBanner() {
  const limitedUntil = useThrottle((s) => s.limitedUntil);
  const breakers = useThrottle((s) => s.breakers);
  /*
   * The clock only runs while there is a number counting down.
   *
   * `limitedUntil` clears itself when its window closes (`throttleStore.ts`), so this mounts for the length
   * of a limit and not for the rest of the session. A breaker banner names no seconds, so it ticks at the
   * default minute — enough to notice `/health` has stopped reporting one.
   */
  if (limitedUntil === 0 && openBreakers(breakers).length === 0) return null;
  return <LiveThrottleBanner limitedUntil={limitedUntil} breakers={breakers} />;
}

function LiveThrottleBanner({
  limitedUntil,
  breakers,
}: {
  limitedUntil: number;
  breakers: ThrottleState['breakers'];
}) {
  const now = useNow(limitedUntil > 0 ? 1_000 : 60_000);
  const banner = throttleBanner({ limitedUntil, breakers }, now);
  if (!banner) return null;
  return (
    <View
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        left: space.s16,
        right: space.s16,
        bottom: space.s26,
        backgroundColor: colors.surfaceAlt,
        borderRadius: radius.card,
        paddingHorizontal: space.s16,
        paddingVertical: space.s12,
        gap: space.s4,
      }}
      accessibilityLiveRegion="polite"
    >
      <Text variant="rowPrimary" color={colors.ink}>
        {banner.title}
      </Text>
      <Text variant="footnote" color={colors.ink40}>
        {banner.detail}
      </Text>
    </View>
  );
}

/**
 * The session ended while the app was open.
 *
 * Said in one place with the one control that helps. Every screen still raises its own
 * `SessionExpired` — a screen that silently showed nothing would be back to the emptiness problem
 * the offline banner exists to prevent — but the prompt is not theirs to draw, because the fix is
 * not on any of them.
 *
 * A banner rather than a modal, for the same reason as the others: a dead session does not touch
 * the delegation, which lives on chain and is revoked by a signature the user makes themselves. The
 * kill switch still works, and covering the app would take that away at the moment someone might
 * most want it.
 */
function SessionEndedBanner() {
  return (
    <View style={PASS_THROUGH_PANEL} accessibilityLiveRegion="polite">
      <View style={SENTENCES}>
        <Text variant="rowPrimary" color={colors.ink}>
          {SESSION_ENDED_TITLE}
        </Text>
        <Text variant="footnote" color={colors.ink40}>
          {SESSION_ENDED_DETAIL}
        </Text>
      </View>
      <Press
        onPress={signIn}
        accessibilityRole="button"
        accessibilityLabel="Sign in again"
        hitHeight={size.hit}
        style={{ alignSelf: 'flex-start' }}
      >
        <Text variant="footnote" color={colors.ink}>
          Sign in ›
        </Text>
      </Press>
    </View>
  );
}
