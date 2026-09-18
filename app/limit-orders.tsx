/**
 * Limit orders — PLAN.md 3.15.
 *
 * The 1inch limit orders makers have published to this executor, each with what the chain says of it right now: its
 * price, its size, who made it, when it expires and whether it can still be taken. "Take" fills the whole order through
 * the trading permission — `XorrDelegation.spend()` pays the order's USDC and the router sends the maker's WETH straight
 * to this wallet — and what arrived is shown under the order, with its transaction.
 *
 * Taking is reviewed first, as a swap is: the first press says what confirming pays and delivers, and only a second
 * press on the same order sends it. It spends real USDC against today's limit, so one tap never does.
 *
 * Where nothing settles (Base Sepolia) the executor lists nothing and says why, and this screen says so too — without
 * the network's name, which the executor's sentence carries — rather than showing orders no fill could reach.
 *
 * Each order names what it sells, so the subtitle does not: it said "a signed WETH price" above every order.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  EmptyList,
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Price,
  Row,
  Screen,
  SheetCard,
  Tag,
  Text,
  FigureSpan,
  colors,
  money,
  quantity,
  radius,
  size,
  space,
  type TagTone,
} from '@/ui';
import { shortAddress, when } from '@/format';
import { useAsync } from '@/data/useAsync';
import { useIntentKeys } from '@/data/useIntentKeys';
import { errorText } from '@/data/apiError';
import {
  fillLimitOrder,
  limitOrders,
  type LimitFillOutcome,
  type LimitOrder,
  type LimitOrderStatus,
} from '@/data/limitOrders';

/** Categories, not outcomes: green and red stay for profit and loss. */
const STATUS: Readonly<Record<LimitOrderStatus, { label: string; tone: TagTone }>> = {
  open: { label: 'Open', tone: 'neutral' },
  filled: { label: 'Taken', tone: 'neutral' },
  invalidated: { label: 'Spent', tone: 'warn' },
  expired: { label: 'Expired', tone: 'warn' },
  unfunded: { label: 'Unfunded', tone: 'warn' },
  unknown: { label: 'Not read', tone: 'warn' },
};

export default function LimitOrders() {
  const goBack = useGoBack();
  const { data, loading, error, reload, settledAt } = useAsync(() => limitOrders(), []);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [taking, setTaking] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, LimitFillOutcome>>({});

  /** The first press reviews an order; only a second press on the same order takes it. */
  function press(order: LimitOrder) {
    if (taking) return;
    if (reviewing !== order.hash) {
      setReviewing(order.hash);
      return;
    }
    void take(order);
  }

  /*
   * Taking an order is a trade, and it went out with no key: a timeout and a second press could fill a second time. The
   * same order pressed again after an unknown outcome now carries the same key.
   */
  const keys = useIntentKeys();

  async function take(order: LimitOrder) {
    setReviewing(null);
    setTaking(order.hash);
    try {
      const outcome = await keys.send(['take', order.hash], (idempotencyKey) =>
        fillLimitOrder(order.hash, { idempotencyKey }),
      );
      setOutcomes((all) => ({ ...all, [order.hash]: outcome }));
      // The order's own state changed on chain; read the list again rather than guess it.
      if (outcome.status === 'filled') reload();
    } catch (e) {
      setOutcomes((all) => ({ ...all, [order.hash]: { status: 'failed', error: errorText(e) } }));
    } finally {
      setTaking(null);
    }
  }

  const orders = data?.orders ?? [];

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Limit orders</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          Take a signed price, all or nothing.
        </Text>
      </View>

      <Fill style={{ marginTop: space.s16 }}>
        {error && !data ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <ErrorState error={error} onRetry={reload} />
          </View>
        ) : loading && !data ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <LoadingRows count={3} height={size.rowLg} />
          </View>
        ) : data && !data.settles ? (
          <EmptyState text="No limit orders on this network." />
        ) : orders.length === 0 ? (
          <EmptyList list="limitOrders" />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.s30, gap: space.s10 }}
          >
            {orders.map((order) => (
              <OrderCard
                key={order.hash}
                order={order}
                readAt={settledAt}
                reviewing={reviewing === order.hash}
                taking={taking === order.hash}
                busy={taking !== null}
                outcome={outcomes[order.hash]}
                onPress={() => press(order)}
              />
            ))}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}

function OrderCard({
  order,
  readAt,
  reviewing,
  taking,
  busy,
  outcome,
  onPress,
}: {
  order: LimitOrder;
  /** When the list was read: expiry is said relative to that, not to a clock that keeps moving. */
  readAt: number | undefined;
  /** Pressed once: the button asks for confirmation, and the sentence under it says what confirming does. */
  reviewing: boolean;
  taking: boolean;
  busy: boolean;
  outcome: LimitFillOutcome | undefined;
  onPress: () => void;
}) {
  const status = STATUS[order.status];
  const takeable = order.fillable === true && outcome?.status !== 'filled';
  const costLabel = `${quantity(order.cost, 2)} ${order.pays}`;
  const sizeLabel = `${quantity(order.size)} ${order.sells}`;

  return (
    <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s10 }}>
        <View style={{ flexShrink: 1 }}>
          {/* A maker's published order: its price, size and cost are public, and stay while balances are hidden. */}
          <Price variant="priceMd" figure="market">
            {money(order.price)}
          </Price>
          <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s2 }}>
            per {order.sells}, paid in {order.pays}
          </Text>
        </View>
        <Tag label={status.label} tone={status.tone} />
      </View>

      <View style={{ marginTop: space.s10 }}>
        <Row title="Size" value={<Price figure="market">{sizeLabel}</Price>} height={40} />
        <Row title="Costs" value={<Price figure="market">{costLabel}</Price>} height={40} />
        <Row
          title="Maker"
          value={
            <Text variant="rowPrimary" color={colors.ink55}>
              {shortAddress(order.maker)}
            </Text>
          }
          height={40}
        />
        <Row
          title="Expires"
          value={
            <Text variant="rowPrimary" color={colors.ink55}>
              {expiry(order.expiresAt, readAt)}
            </Text>
          }
          height={40}
          divider={false}
        />
      </View>

      {order.status !== 'open' ? (
        <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s8 }}>
          {order.takenByYou ? 'You took this order.' : order.detail}
        </Text>
      ) : null}

      {takeable ? (
        <Button
          label={reviewing ? `Confirm: ${costLabel} for ${sizeLabel}` : `Take for ${costLabel}`}
          variant="secondary"
          loading={taking}
          disabled={busy && !taking}
          onPress={onPress}
          style={{ marginTop: space.s12 }}
        />
      ) : null}

      {takeable && reviewing ? (
        <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s8 }}>
          {`You pay ${costLabel} and receive ${sizeLabel}.`}
        </Text>
      ) : null}

      <Outcome outcome={outcome} pays={order.pays} />
    </SheetCard>
  );
}

/** What taking the order did: what arrived and in which transaction, or the executor's reason nothing moved. */
function Outcome({ outcome, pays }: { outcome: LimitFillOutcome | undefined; pays: string }) {
  if (!outcome) return null;
  if (outcome.status === 'filled') {
    /*
     * What arrived and what it cost are the person's money, and hide while balances are hidden (FEATURES.md #47). The
     * words and the transaction beside them are not figures, so the line is `market` and the two amounts are spans.
     */
    return (
      <Text variant="footnote" color={colors.ink} style={{ marginTop: space.s10 }} figure="market">
        {`${outcome.measured ? 'Bought' : 'Bought at least'} `}
        <FigureSpan figure="units">{quantity(outcome.received)}</FigureSpan>
        {` ${outcome.bought} for `}
        <FigureSpan figure="units">{quantity(outcome.paid, 2)}</FigureSpan>
        {` ${pays} · ${shortAddress(outcome.txHash, 10, 4)}`}
      </Text>
    );
  }
  return (
    <Text variant="footnote" color={colors.down} style={{ marginTop: space.s10 }}>
      {outcome.status === 'blocked' ? outcome.detail : outcome.error}
    </Text>
  );
}

/** When an order stops being takeable, from the moment the list was read. */
function expiry(expiresAt: number | null, readAt: number | undefined): string {
  if (expiresAt === null) return 'Never';
  if (readAt === undefined) return when(expiresAt);
  const minutes = Math.floor((expiresAt - readAt) / 60_000);
  if (minutes < 1) return 'Passed';
  if (minutes < 60) return `In ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `In ${hours} h`;
  return `In ${Math.floor(hours / 24)} days`;
}
