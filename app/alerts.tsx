/**
 * Screen 18 — Alerts. screens.md Group D.
 *
 * "{n} of {m} on". 70pt switch rows for the alerts YOU set, then a second group for what
 * the BOT interrupts you for. Note strip: "Circuit breakers stay on even when notifications
 * are muted. They stop trading, not just your phone." Ghost "Add custom alert".
 *
 * Distilled 2026-09-14 (PLAN.md O3): a line per section. Signed out it asks for a sign-in, rather than counting
 * "0 of 0 on" and saying a wallet nobody named has no alerts.
 */
import React, { useCallback, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  BackButton,
  Button,
  EmptyList,
  Fill,
  LoadingRows,
  NoteStrip,
  Screen,
  SwitchRow,
  Text,
  colors,
  space,
  ErrorState,
  SignInPrompt,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { repos } from '@/data';
import { api } from '@/data/api';
import { errorText } from '@/data/apiError';
import { useAsync } from '@/data/useAsync';
import { useRefreshControl } from '@/ui/useRefreshControl';
import type { Alert } from '@/data/types';
import { useGoBack } from '@/nav/useGoBack';

const ROW_H = 70;

/**
 * What this alert is doing right now, in one line.
 *
 * There are three states behind a switch that is on, not one: watching, fired-and-waiting,
 * and fired-before-but-watching-again. They are the executor's (server/src/alerts/evaluate.ts):
 * an alert fires once per crossing — it disarms when it fires, re-arms when its condition goes
 * false again, and fires again on the next crossing. It never switches itself off; only this
 * screen does that.
 */
function firedCaption(a: Alert): string {
  if (a.armed === false && a.lastFiredAt) {
    return `Went off ${when(a.lastFiredAt)} · quiet until it clears`;
  }
  if (a.fireCount && a.lastFiredAt) return `Watching · last went off ${when(a.lastFiredAt)}`;
  return a.detail;
}

/** Relative where it reads better, absolute once "hours ago" stops meaning anything. */
function when(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

type Pref = { kind: string; label: string; detail: string; enabled: boolean };

/**
 * Switch positions asked for and not yet overtaken by a fresh read, keyed to the read they were made on.
 *
 * When the list is read again (`settledAt` moves) the server's word stands — including for a save that succeeded,
 * which that read now carries.
 */
type Pending = { at: number | undefined; on: Record<string, boolean> };
const NOTHING_PENDING: Pending = { at: undefined, on: {} };

export default function Alerts() {
  const goBack = useGoBack();
  const router = useRouter();
  const { data, loading, error, reload, settledAt } = useAsync(() => repos.alerts.list(), []);
  const prefs = useAsync(() => api.get<Pref[]>('/notifications/prefs'), []);
  // Both halves of this screen come from the server, so both are refreshed by the gesture.
  const refresh = useRefreshControl(() => Promise.all([reload(), prefs.reload()]));
  /*
   * Back from adding one, the list is read again. An alert created on an Android 15 emulator was missing from the list it
   * returned to, which went on saying "No alerts yet." (2026-09-15): the form closes back over this screen, which is not
   * mounted again. Not on the first focus, which is the mount and has its own read.
   */
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      reload();
    }, [reload]),
  );
  const signedOut = useSignedOut();

  /*
   * On or off is the SERVER's answer, with a local position only while a save is in flight.
   *
   * The alert switches read `alerts[a.name] ?? a.default` — a map persisted on this device, keyed
   * by name and still carrying the fixture catalogue's entries — and `setEnabled` swallowed its own
   * failure. So a save the executor refused, or never received, flipped the row anyway, and the
   * device remembered a state the executor never had. A failed save now puts the switch back and
   * says why, for both groups on this screen.
   */
  const [alertSaves, setAlertSaves] = useState<Pending>(NOTHING_PENDING);
  const [prefSaves, setPrefSaves] = useState<Pending>(NOTHING_PENDING);
  const [saveError, setSaveError] = useState<string>();
  const alertOn = (a: Alert) =>
    (alertSaves.at === settledAt ? alertSaves.on[a.id] : undefined) ?? a.default;
  const prefOn = (p: Pref) =>
    (prefSaves.at === prefs.settledAt ? prefSaves.on[p.kind] : undefined) ?? p.enabled;

  /** Show the new position now, write it, and put it back — with the executor's reason — if the write fails. */
  async function save(
    key: string,
    next: boolean,
    at: number | undefined,
    setSaves: React.Dispatch<React.SetStateAction<Pending>>,
    write: () => Promise<unknown>,
    label: string,
  ) {
    setSaveError(undefined);
    setSaves((s) => ({ at, on: { ...(s.at === at ? s.on : {}), [key]: next } }));
    try {
      await write();
    } catch (e) {
      setSaves((s) => {
        const on = { ...s.on };
        delete on[key];
        return { ...s, on };
      });
      setSaveError(`${label} did not save: ${errorText(e)}`);
    }
  }

  /*
   * Count the alerts that EXIST, not the toggle map.
   *
   * `alertsOnCount` counted every key the local store had ever written, which still held
   * entries for the fixture catalogue this account replaced — so a wallet with one alert
   * read "2 of 1 on". A count larger than the list it counts is the kind of small wrongness
   * that makes a user stop believing the rest of the screen.
   */
  const onCount = (data ?? []).filter(alertOn).length;

  return (
    <Screen>
      {/*
        A pushed screen needs a way back that is visible.

        This had none: the only exit was iOS's edge-swipe, which is undiscoverable and does not
        exist on web at all. Same header as History, which had it right.
      */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
          <BackButton onPress={() => goBack()} />
          <Text variant="screenTitle">Alerts</Text>
        </View>
        {/*
          A count of the list the server gave. Before it answers there is nothing to count, and an empty list is
          said once, by the empty state: "0 of 0 on" above "No alerts yet." said it twice.
        */}
        {data && data.length > 0 ? (
          <Text variant="footnote" color={colors.ink55}>
            {onCount} of {data.length} on
          </Text>
        ) : null}
      </View>

      <Text variant="secondary" style={{ marginTop: space.s10 }}>
        The moments worth interrupting you for.
      </Text>

      <Fill style={{ marginTop: space.s14 }}>
        {signedOut ? (
          <SignInPrompt />
        ) : loading && !data ? (
          <LoadingRows count={5} height={ROW_H} />
        ) : error && !data ? (
          /* A list that could not be read is not an empty one, and must not look like one. */
          <ErrorState error={error} onRetry={reload} />
        ) : (
          <ScrollView refreshControl={refresh.control} showsVerticalScrollIndicator={false}>
            {/* A pull that failed says so, over the rows it could not replace. A success says nothing. */}
            {refresh.notice}
            {/*
              No alerts is a real state, not a reason to show a catalogue.

              This used to fall through to fixtures — five sample alerts, two of them on things
              this app cannot trade, counted in the header as though the user had set them. An
              empty list now says it is empty; the button that fixes that is below the list.
            */}
            {(data ?? []).length === 0 ? <EmptyList list="alerts" /> : null}
            {(data ?? []).map((a) => (
              <SwitchRow
                key={a.id}
                label={a.name}
                // The caption changes with state, as design.md §5 requires.
                caption={(v) => (v ? firedCaption(a) : 'Off')}
                on={alertOn(a)}
                onChange={(next) =>
                  void save(a.id, next, settledAt, setAlertSaves, () => repos.alerts.setEnabled(a.id, next), a.name)
                }
                height={ROW_H}
                compact
              />
            ))}

            {/*
              What the BOT interrupts you for, as opposed to what you asked it to watch.
              The switches above are alerts you set. These are the app's own notifications,
              and `send()` has carried a kind since it was written with nothing reading it —
              so muting the app meant losing "your cap stopped a trade" along with the
              routine fills. Those are not the same thing and should not share one switch.
            */}
            <Text variant="cardTitle" style={{ marginTop: space.s26, marginBottom: space.s4 }}>
              What the bot tells you
            </Text>
            {prefs.error && !prefs.data ? <ErrorState error={prefs.error} onRetry={prefs.reload} /> : null}
            {(prefs.data ?? []).map((p) => (
              <SwitchRow
                key={p.kind}
                label={p.label}
                caption={() => p.detail}
                on={prefOn(p)}
                onChange={(next) =>
                  void save(
                    p.kind,
                    next,
                    prefs.settledAt,
                    setPrefSaves,
                    () => api.post('/notifications/prefs', { kind: p.kind, enabled: next }),
                    p.label,
                  )
                }
                height={ROW_H}
                compact
              />
            ))}

            <NoteStrip kind="risk" style={{ marginTop: space.s16 }}>
              Muting never turns off the circuit breakers.
            </NoteStrip>
          </ScrollView>
        )}
      </Fill>

      {/* Outside the list, so the reason a switch went back is on screen wherever the list is scrolled. */}
      {saveError && !signedOut ? (
        <Text variant="secondarySm" color={colors.down} style={{ marginTop: space.s10 }}>
          {saveError}
        </Text>
      ) : null}

      {signedOut ? null : (
        <Button
          label="Add custom alert"
          variant="ghost"
          onPress={() => router.push('/alerts/new')}
          style={{ marginTop: space.s14 }}
        />
      )}
    </Screen>
  );
}
