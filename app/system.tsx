/**
 * The executor and everything it needs to work.
 *
 * At `/system`, not `/status`. Expo's dev server answers `/status` itself with a plain-text
 * `packager-status:running`, so the route never reached the app router and the screen was
 * unreachable in development — an easy thing to miss, because the URL loads and returns 200.
 * Colliding with a well-known dev-server path is a trap worth designing out rather than working
 * around.
 *
 * `/health` names each dependency, whether it answered, how long it took and — importantly —
 * whether it is critical. That last field is why this is a screen rather than a green dot: gas
 * being low is not the same kind of fact as Postgres being down, and a single "healthy" badge
 * flattens the two into one word that is wrong half the time.
 *
 * Latency is shown per dependency. A database that answers in 400ms is not down, and it is also
 * not fine, and there is no other place in the app that would ever tell you.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  size,
  space,
} from '@/ui';
import { useAsync } from '@/data/useAsync';
import { system, type HealthDependency } from '@/data/system';
import { shortAddress } from '@/format';
import { useNow } from '@/state/useNow';
import { openBreakers, type Breaker } from '@/net/throttle';

const DOT = 8;
/** A timestamp as the executor writes one into a detail: ISO 8601, UTC, optionally after "at". */
const ISO_STAMP = /\b(?:at )?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/g;

function toneFor(status: string): string {
  if (status === 'up') return colors.up;
  if (status === 'down') return colors.down;
  return colors.warn;
}

/** Seconds into something a person reads without converting. */
function uptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/**
 * How long ago, in a person's words.
 *
 * The database probe reports "responded at 2026-09-13T22:20:15.739Z" — a log line's timestamp,
 * milliseconds and all, on a screen someone reads. Measured against this device's clock, so a second
 * or two of skew is possible; nothing here needs finer than that.
 */
function ago(at: number, now: number): string {
  if (!Number.isFinite(at)) return '—';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** A dependency's detail, with any timestamp in it said as an age. Everything else is left as sent. */
function readableDetail(detail: string, now: number): string {
  return detail.replace(ISO_STAMP, (_match, iso: string) => ago(Date.parse(iso), now));
}

export default function Status() {
  const goBack = useGoBack();
  const { data, loading, error, reload } = useAsync(() => system.health(), []);
  // An age has to keep counting while the screen is open, or "just now" goes on being said forever.
  const now = useNow(15_000);

  const deps = data?.dependencies ?? [];
  /* The hosts the circuit breaker has shut out right now, as the executor reported them. */
  const open = openBreakers(data?.breakers ?? [], now);
  const criticalDown = deps.filter((d) => d.critical && d.status !== 'up').length;

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">System</Text>} />
      </View>

      <Fill style={{ marginTop: space.s16 }}>
        {error ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <ErrorState error={error} onRetry={reload} />
          </View>
        ) : loading && !data ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <LoadingRows count={5} height={size.row} />
          </View>
        ) : !data ? null : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: space.gutter,
              paddingBottom: space.s30,
              gap: space.s10,
            }}
          >
            <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
              <Text variant="footnote" color={colors.ink55}>
                EXECUTOR
              </Text>
              <Text
                variant="screenTitle"
                color={criticalDown > 0 ? colors.down : colors.up}
                style={{ marginTop: space.s6 }}
              >
                {criticalDown > 0 ? 'Degraded' : 'Up'}
              </Text>
              <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }}>
                {data.chain} · up {uptime(data.uptimeSec)}
              </Text>
              <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s4 }}>
                {shortAddress(data.delegation)}
              </Text>
            </SheetCard>

            {deps.map((d) => (
              <DependencyRow key={d.name} dep={d} now={now} />
            ))}

            {/*
              Which upstreams the executor is refusing to call right now.
              
              The `upstreams` dependency above says only whether any breaker is open. This is the detail
              behind it: which host, how many failures opened it, and when it tries again. While one is open
              prices and quotes come from fewer sources, and a screen showing a dash instead of a number is
              showing the truth about that host rather than a fault of its own.
            */}
            {open.length > 0 ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                <Text variant="footnote" color={colors.ink55}>
                  ROUTING AROUND
                </Text>
                {open.map((b) => (
                  <View
                    key={b.host}
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      gap: space.s10,
                      marginTop: space.s8,
                    }}
                  >
                    <Text variant="secondary" color={colors.ink} style={{ flex: 1 }} selectable>
                      {b.host}
                    </Text>
                    <Text variant="footnote" color={colors.ink55}>
                      {breakerDetail(b, now)}
                    </Text>
                  </View>
                ))}
              </SheetCard>
            ) : null}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}

function DependencyRow({ dep, now }: { dep: HealthDependency; now: number }) {
  return (
    <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10 }}>
        <View
          style={{
            width: DOT,
            height: DOT,
            borderRadius: DOT / 2,
            backgroundColor: toneFor(dep.status),
          }}
        />
        <Text variant="rowPrimary" style={{ flex: 1 }}>
          {dep.name}
        </Text>
        {/*
          Critical is worth saying out loud. "gas: low" and "postgres: down" are both amber-ish
          words and only one of them stops the product working.
        */}
        {dep.critical ? null : (
          <Text variant="footnote" color={colors.ink55}>
            not critical
          </Text>
        )}
        {dep.ms === undefined ? null : (
          <Text variant="footnote" color={dep.ms > 500 ? colors.warn : colors.ink40}>
            {dep.ms}ms
          </Text>
        )}
      </View>
      {dep.detail ? (
        <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }}>
          {readableDetail(dep.detail, now)}
        </Text>
      ) : null}
    </SheetCard>
  );
}

/** One open breaker, in the two facts worth knowing: how many failures opened it, and when it tries again. */
function breakerDetail(b: Breaker, now: number): string {
  const failures = `${b.failures} ${b.failures === 1 ? 'failure' : 'failures'}`;
  const seconds = Math.ceil((b.openUntil - now) / 1000);
  // A breaker already past its window is one the executor has not yet reported closing: said, not guessed at.
  return seconds > 0 ? `${failures} · retries in ${seconds}s` : `${failures} · retrying`;
}
