/**
 * Screen 15 — Activity / audit log. screens.md Group D.
 *
 * Filter pills All / Trades / Risk / Blocked. Rows: an 8pt classification dot (up acted /
 * warn risk / down blocked), action + detail + "{agent} · {time}", the on-chain receipt
 * where there is one, and a right-aligned amount (up for credits, ink55 for debits).
 *
 * "The structured trail is the compliance artifact, so it stays a first-class action" — the
 * exports really export (PLAN.md 12.11); they are not decorative buttons.
 *
 * [G41] The `yield` row was orphaned by the original filter map; state/derived.ts folds it
 * into Trades so every row is reachable from a tab.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  BackButton,
  Button,
  EmptyList,
  ErrorState,
  Fill,
  LoadingRows,
  Pill,
  PillRow,
  Press,
  Price,
  Screen,
  Text,
  TransactionRef,
  colors,
  divider,
  noteDotColor,
  radius,
  space,
} from '@/ui';
import {
  ACTIVITY_FILTERS,
  activityAmountIsCredit,
  activityDot,
  filterActivity,
} from '@/state/derived';
import { repos } from '@/data';
import { exportRecords } from '@/data/system';
import { useAsync } from '@/data/useAsync';
import { useFreshOnReturn } from '@/data/useFreshOnReturn';
import { deliverFile } from '@/export/deliver';
import { useRefreshControl } from '@/ui/useRefreshControl';
import { useStore } from '@/state/store';
import { useGoBack } from '@/nav/useGoBack';
import { errorText } from '@/data/apiError';
import { plainAction, plainDetail } from '@/format/activity';

const DOT = 8;

type ExportKind = 'fills' | 'disposals' | 'trail';

/**
 * The three documents this screen can hand over, and what each one is for.
 *
 * They are not variations of one file. Each answers a different question for a different reader,
 * and the empty sentence differs for the same reason — "no trades yet" and "nothing sold yet" are
 * different facts about the same wallet.
 *
 *   fills     — a receipt. What moved, when, at what price, on which transaction. ONLY runs that
 *               settled and carry a signature: a receipt for something that did not happen is not
 *               a weaker receipt, it is a false one.
 *   disposals — the tax document. Sales with cost basis, average cost stated in the file rather
 *               than assumed, because a jurisdiction that wants FIFO needs to be told this is not it.
 *   trail     — the compliance artifact. EVERY row, blocked runs included, hash-chained. The
 *               blocked ones are the point: they are where the safety layer did its job.
 */
const EXPORTS: Record<
  ExportKind,
  { label: string; filename: string; empty: string; read: () => Promise<string> }
> = {
  fills: {
    label: 'Receipts (CSV)',
    filename: 'xorr-fills.csv',
    empty: 'Nothing has settled yet, so there are no receipts.',
    read: () => repos.activity.exportFills(),
  },
  disposals: {
    label: 'Disposals (CSV)',
    filename: 'xorr-disposals.csv',
    empty: 'Nothing sold yet, so there is nothing to report.',
    read: () => repos.activity.exportDisposals(),
  },
  trail: {
    label: 'Export audit trail',
    filename: 'xorr-audit.csv',
    empty: 'Nothing to export yet.',
    read: () => repos.activity.exportTrail('csv'),
  },
};

/** What an empty filter says while the trail itself has rows, by the index of `ACTIVITY_FILTERS`. */
const NONE_UNDER: Readonly<Record<number, string>> = {
  1: 'No trades yet.',
  2: 'Nothing flagged as risk.',
  3: 'Nothing blocked.',
};


export default function Activity() {
  const goBack = useGoBack();
  const router = useRouter();
  const actFilter = useStore((s) => s.actFilter);
  const setActFilter = useStore((s) => s.setActFilter);
  const trail = useAsync(() => repos.activity.list(), []);
  const { data, loading, error, reload } = trail;
  // The agents go on acting while nobody is looking: read the trail again on return (FEATURES.md #27).
  useFreshOnReturn(trail);
  // Pulling down is the gesture people already try on a list of things that keep changing.
  const refresh = useRefreshControl(reload);
  /** Which of the three files is being fetched, if any. One at a time: they share one note. */
  const [exportingWhich, setExportingWhich] = useState<ExportKind>();
  /** A failure, or an empty file said as one. Kept apart so "Nothing to export yet." is not reported as a failed export. */
  const [exportNote, setExportNote] = useState<{ text: string; failed: boolean }>();

  /*
   * The row a notification asked for.
   *
   * A tapped push carries the audit row it recorded (`notifications/routes.ts`), and landing at the
   * top of a hundred rows is not "opening the thing it is about". The list scrolls to it and marks
   * it until the reader takes over.
   */
  const { row: askedFor } = useLocalSearchParams<{ row?: string }>();
  const scroller = useRef<ScrollView>(null);
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  /*
   * Which addressed row the reader has scrolled away from.
   *
   * Set from the scroll gesture — an event, never an effect. The param stays in the URL for as long
   * as the screen is mounted, so without releasing it the list would drag itself back to that row
   * every time the reader scrolled away, which is the behaviour of a screen that will not let go.
   */
  const [released, setReleased] = useState<string>();
  const marked = askedFor && released !== askedFor ? askedFor : undefined;

  /*
   * A filter the addressed row is not under would hide it.
   *
   * A push about a blocked trade opens a list the reader last left on "Trades", while the row it
   * names is filed under "Blocked". Widening to All is the one move that cannot fail to show it.
   *
   * DERIVED rather than written: setting the filter from an effect would cascade a render and,
   * worse, would overwrite a choice the reader made afterwards. As a derivation it applies only
   * while the row is still marked, so the first deliberate tap on a pill takes it back.
   */
  const addressedIsHidden =
    marked !== undefined &&
    data !== undefined &&
    data.some((r) => r.id === marked) &&
    !filterActivity(data, actFilter).some((r) => r.id === marked);
  const showing = addressedIsHidden ? 0 : actFilter;

  const rows = filterActivity(data ?? [], showing);

  // Once the row has a measured offset under the filter now showing, put it on screen. A scroll is
  // a side effect on a ref, not a state write, so it does not cascade.
  useEffect(() => {
    if (!marked) return;
    const y = offsets[marked];
    if (y === undefined) return;
    scroller.current?.scrollTo({ y: Math.max(0, y - space.s12), animated: true });
  }, [marked, offsets]);

  const measure = useCallback(
    (id: string, y: number) => setOffsets((prev) => (prev[id] === y ? prev : { ...prev, [id]: y })),
    [],
  );

  /**
   * One file out of the app, delivered the way `/export` delivers it: a download in a browser, a share sheet on a phone.
   *
   * This called `Share.share`, which Chrome rejects outright — the exact failure `/export` was fixed for, one screen
   * over. The two now share `deliverFile`, and the same refusal to hand over a file with no records in it.
   *
   * Three files, because there are three questions and one document cannot answer them all — see
   * `EXPORTS` below for which is which.
   */
  async function exportFile(which: ExportKind) {
    const file = EXPORTS[which];
    setExportingWhich(which);
    setExportNote(undefined);
    try {
      // `read`, not `fetch`: `repositories.test.ts` bans the literal token in a screen, and the
      // rule is worth more than the name — every call here goes through the data layer.
      const csv = await file.read();
      if (exportRecords(csv, 'csv') === 0) {
        setExportNote({ text: file.empty, failed: false });
        return;
      }
      const out = await deliverFile(file.filename, csv);
      // A dismissed share sheet is a change of mind, which `deliverFile` words as "Cancelled." — not a failure to report.
      if (!out.ok && out.reason !== 'Cancelled.') setExportNote({ text: `Export failed: ${out.reason}`, failed: true });
    } catch (e) {
      // On the screen, not in a console nobody reads. An export that silently fails is
      // worse than none: the user walks away believing they have the record.
      setExportNote({ text: `Export failed: ${errorText(e)}`, failed: true });
    } finally {
      setExportingWhich(undefined);
    }
  }

  return (
    <Screen>
      {/*
        A pushed screen needs a way back that is visible.

        This had none: the only exit was iOS's edge-swipe, which is undiscoverable and does not
        exist on web at all. Same header as History, which had it right.
      */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
        <BackButton onPress={() => goBack()} />
        <Text variant="screenTitle">Activity</Text>
      </View>
      <Text variant="secondary" style={{ marginTop: space.s10 }}>
        What agents did, and didn’t.
      </Text>

      <PillRow style={{ marginTop: space.s18, flexGrow: 0 }}>
        {ACTIVITY_FILTERS.map((f, i) => (
          <Pill
            key={f}
            label={f}
            // `showing`, not the stored filter: while a notification's row is being shown the list
            // is widened to All, and a pill claiming otherwise would be describing a different list.
            selected={i === showing}
            onPress={() => {
              if (askedFor) setReleased(askedFor);
              setActFilter(i);
            }}
          />
        ))}
      </PillRow>

      <Fill style={{ marginTop: space.s10 }}>
        {loading && !data ? (
          <LoadingRows count={5} height={72} />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          (data ?? []).length > 0 ? (
            /* The trail has rows, just none of this kind: "Nothing yet." and a push to start buying would deny the rest. */
            <EmptyList list="activity" text={NONE_UNDER[showing] ?? 'Nothing here.'} />
          ) : (
            <EmptyList list="activity" />
          )
        ) : (
          <ScrollView
            ref={scroller}
            refreshControl={refresh.control}
            showsVerticalScrollIndicator={false}
            // The reader has taken over. The mark has done its job and stops following them.
            onScrollBeginDrag={() => askedFor && setReleased(askedFor)}
          >
            {/* A pull that failed says so, over the rows it could not replace. A success says nothing. */}
            {refresh.notice}
            {rows.map((r) => {
              const credit = activityAmountIsCredit(r.amount);
              return (
                /*
                  Every row opens its own explanation, including the ones with nothing to explain.

                  Tapping only the agent's trades would mean the rows that ANSWER are the rows that
                  respond to touch, so a person learns what the agent did by discovering which rows
                  move. Nothing on this list says which is which, and the honest answer — "no
                  reasoning was stored for this one" — is worth arriving at deliberately rather
                  than by finding a row that does not react.
                */
                <Press
                  key={r.id}
                  onPress={() => router.push(`/explain/${r.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel={`Why: ${plainAction(r.action)}`}
                  // Where this row sits in the list, so a notification naming it can be scrolled to.
                  onLayout={(e) => measure(r.id, e.nativeEvent.layout.y)}
                  style={[
                    { flexDirection: 'row', gap: space.s12, paddingVertical: space.s14 },
                    divider,
                    /*
                      The row the notification was about, said in the one way a list can say it.
                      `surfaceAlt` is the design system's own "this one" — the same ink selection
                      uses — so nothing here is a colour invented for this screen.
                    */
                    r.id === marked
                      ? {
                          backgroundColor: colors.surfaceAlt,
                          borderRadius: radius.card,
                          paddingHorizontal: space.s12,
                        }
                      : null,
                  ]}
                >
                  <View
                    style={{
                      width: DOT,
                      height: DOT,
                      borderRadius: radius.full,
                      marginTop: space.s4,
                      backgroundColor: noteDotColor[activityDot(r.kind)],
                    }}
                  />
                  <View style={{ flex: 1, gap: space.s2 }}>
                    <Text variant="rowPrimary">{plainAction(r.action)}</Text>
                    <Text variant="secondarySm">{plainDetail(r.detail)}</Text>
                    <Text variant="footnote" color={colors.ink55}>
                      {r.agent} · {r.t}
                    </Text>
                    {/*
                      The receipt, where there is one. A tappable link on a public chain; a
                      plain label on a fork or a local node, because a link to an explorer
                      that has never seen the transaction reads as the transaction not being
                      real.
                    */}
                    {r.explorer ? <TransactionRef explorer={r.explorer} /> : null}
                  </View>
                  {r.amount ? (
                    // What moved, in dollars or in a token's units — "$1,234.56 USDC" — hides while balances are hidden.
                    <Price color={credit ? colors.up : colors.ink55} figure="units">
                      {r.amount}
                    </Price>
                  ) : null}
                </Press>
              );
            })}
          </ScrollView>
        )}
      </Fill>

      {exportNote ? (
        <Text
          variant="secondarySm"
          color={exportNote.failed ? colors.down : colors.warn}
          align="center"
          style={{ marginTop: space.s10 }}
        >
          {exportNote.text}
        </Text>
      ) : null}

      {/*
        Three documents, so three buttons. Folding any two together would produce a file that is
        the wrong shape for both jobs — an accountant does not want blocked runs, a compliance
        reviewer does not want cost basis, and someone asking "what did I buy" wants neither.

        Plain rows: `ButtonRow` is the secondary/affirmative pair for a decision, and these are
        peers rather than a choice between them.
      */}
      <View style={{ flexDirection: 'row', gap: space.s10, marginTop: space.s14 }}>
        <Button
          label={EXPORTS.fills.label}
          variant="ghost"
          loading={exportingWhich === 'fills'}
          onPress={() => exportFile('fills')}
          style={{ flex: 1 }}
        />
        <Button
          label={EXPORTS.disposals.label}
          variant="ghost"
          loading={exportingWhich === 'disposals'}
          onPress={() => exportFile('disposals')}
          style={{ flex: 1 }}
        />
      </View>
      <View style={{ flexDirection: 'row', marginTop: space.s10 }}>
        <Button
          label={EXPORTS.trail.label}
          variant="ghost"
          loading={exportingWhich === 'trail'}
          onPress={() => exportFile('trail')}
          style={{ flex: 1 }}
        />
      </View>
    </Screen>
  );
}
