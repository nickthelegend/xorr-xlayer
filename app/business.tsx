/**
 * Business — a treasury the bot trades for a company (PLAN.md 4.14).
 *
 * The treasury is a wallet Privy holds under this deployment's policy, owned by its key quorum. It can let the bot trade,
 * approve what that permission pulls, and stop it; Privy refuses anything else before a signature exists. Here the
 * operator creates one, funds it on a test network, lets the bot trade a small daily cap, stops it — and asks for the one
 * thing it must never do, a transfer out, so the refusal is seen rather than described.
 *
 * Every answer carries the treasury read again, so the screen shows what resulted, never the step it asked for.
 */
import React, { useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import { Button, Eyebrow, Fill, HeaderBar, Screen, SheetCard, SignInPrompt, Text, colors, money, radius, space } from '@/ui';
import { shortAddress, when } from '@/format';
import { useSignedOut } from '@/auth/useSignedOut';
import { useAsync } from '@/data/useAsync';
import { errorText } from '@/data/apiError';
import { newIdempotencyKey, outcomeKnown, type Keyed } from '@/data/intentKey';
import { business, type TreasuryAnswer, type TreasuryView } from '@/data/business';
import { plainAction } from '@/format/activity';

/** What a grant from here allows: a small daily cap, for a week. The contract enforces both. */
const CAP_USD = 50;
const DAYS = 7;
const BUY = { symbol: 'WETH', usd: 5 } as const;

type Action = 'create' | 'fund' | 'grant' | 'buy' | 'revoke' | 'prove';
type Act = (action: Action, run: (write: Keyed) => Promise<TreasuryAnswer>) => Promise<void>;

function standing(t: TreasuryView): { text: string; color: string } {
  const p = t.permission;
  if (p.state === 'live') {
    return {
      text: `Trading · ${money(p.dailyCapUsd, { decimals: 0 })} a day · ${money(p.remainingUsd)} left`,
      color: colors.up,
    };
  }
  if (p.state === 'stopped') return { text: 'Stopped', color: colors.warn };
  if (p.state === 'expired') return { text: 'Permission expired', color: colors.warn };
  return { text: 'Not trading', color: colors.ink55 };
}

export default function Business() {
  const goBack = useGoBack();
  const signedOut = useSignedOut();
  const read = useAsync(() => business.treasury(), []);
  /* The treasury as the last answer left it; until an action answers, as the read found it. */
  const [latest, setLatest] = useState<TreasuryView>();
  const [busy, setBusy] = useState<Action>();
  const [note, setNote] = useState<string>();
  const [failure, setFailure] = useState<string>();
  /*
   * One Idempotency-Key per action, kept while its outcome is unknown and dropped once an answer arrives
   * (`src/data/intentKey.ts`): a grant or a buy that timed out and is pressed again cannot happen twice.
   */
  const keys = useRef<Partial<Record<Action, string>>>({});

  const treasury = latest ?? read.data?.treasury ?? undefined;

  const act: Act = async (action, run) => {
    if (busy) return;
    const idempotencyKey = keys.current[action] ?? newIdempotencyKey();
    keys.current[action] = idempotencyKey;
    setBusy(action);
    setNote(undefined);
    setFailure(undefined);
    try {
      const answer = await run({ idempotencyKey });
      delete keys.current[action];
      setLatest(answer.treasury);
      setNote(answer.note);
    } catch (e) {
      if (outcomeKnown(e)) delete keys.current[action];
      setFailure(errorText(e));
      // What a step that failed left behind is the chain's to say, so the treasury is read again.
      setLatest(undefined);
      read.reload();
    } finally {
      setBusy(undefined);
    }
  };

  const message = (
    <>
      {note ? (
        <Text variant="secondarySm" style={{ marginTop: space.s14 }}>
          {note}
        </Text>
      ) : null}
      {failure ? (
        <Text variant="secondarySm" color={colors.down} style={{ marginTop: space.s14 }}>
          {failure}
        </Text>
      ) : null}
    </>
  );

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Business</Text>} />
      </View>

      {signedOut ? (
        <View style={{ paddingHorizontal: space.gutter }}>
          <SignInPrompt text="Sign in to set up a treasury." />
        </View>
      ) : (
        <Fill style={{ marginTop: space.s8 }}>
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.s30 }}
          >
            {treasury ? (
              <Treasury t={treasury} busy={busy} act={act} message={message} />
            ) : read.error ? (
              <View style={{ marginTop: space.s16 }}>
                <Text variant="secondary" color={colors.down}>
                  {errorText(read.error)}
                </Text>
                <Button label="Try again" variant="ghost" onPress={read.reload} style={{ marginTop: space.s12 }} />
              </View>
            ) : read.loading || read.data === undefined ? (
              <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s16 }}>
                Loading…
              </Text>
            ) : (
              <>
                <SheetCard borderRadius={radius.panel} padding={space.s18} style={{ marginTop: space.s16 }}>
                  <Text variant="rowPrimary">No treasury yet</Text>
                  <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s6 }}>
                    Privy holds its key. It can only let the bot trade, or stop it.
                  </Text>
                  <Button
                    label="Create a treasury"
                    loading={busy === 'create'}
                    disabled={busy !== undefined}
                    onPress={() => act('create', (write) => business.create('Treasury', write))}
                    style={{ marginTop: space.s16 }}
                  />
                </SheetCard>
                {message}
              </>
            )}
          </ScrollView>
        </Fill>
      )}
    </Screen>
  );
}

function Treasury({ t, busy, act, message }: { t: TreasuryView; busy: Action | undefined; act: Act; message: React.ReactNode }) {
  const now = standing(t);
  const live = t.permission.state === 'live';
  const working = busy !== undefined;

  return (
    <>
      <Eyebrow small style={{ marginTop: space.s16 }}>
        {`${t.name} · ${shortAddress(t.address)}`}
      </Eyebrow>
      <Text variant="heroBalance" figure="own" style={{ marginTop: space.s8 }}>
        {money(t.balances.usdc)}
      </Text>
      <Text variant="body" color={now.color} style={{ marginTop: space.s6 }}>
        {now.text}
      </Text>

      <SheetCard borderRadius={radius.note} padding={space.s16} style={{ marginTop: space.s18, gap: space.s12 }}>
        <Fact title="Key held by Privy" detail={t.privy.policyId ? 'Policy on' : 'No policy attached'} alarm={!t.privy.policyId} />
        <Fact title="Can’t be sent out" detail="It can only let the bot trade, or stop it." />
      </SheetCard>

      <View style={{ gap: space.s10, marginTop: space.s18 }}>
        {t.fundable !== false && t.balances.usdc < BUY.usd ? (
          <Button
            label="Add test funds"
            loading={busy === 'fund'}
            disabled={working}
            onPress={() => act('fund', (write) => business.fund(write))}
          />
        ) : null}
        {live ? (
          <>
            <Button
              label={`Buy ${money(BUY.usd, { decimals: 0 })} of ${BUY.symbol}`}
              loading={busy === 'buy'}
              disabled={working}
              onPress={() => act('buy', (write) => business.buy(BUY.symbol, BUY.usd, write))}
            />
            <Button
              label="Stop trading"
              variant="ghost"
              loading={busy === 'revoke'}
              disabled={working}
              onPress={() => act('revoke', (write) => business.revoke(write))}
            />
          </>
        ) : (
          <Button
            label={`Let the bot trade · ${money(CAP_USD, { decimals: 0 })} a day`}
            loading={busy === 'grant'}
            disabled={working}
            onPress={() => act('grant', (write) => business.grant(CAP_USD, DAYS, write))}
          />
        )}
        <Button
          label="Try to send it out"
          variant="ghost"
          loading={busy === 'prove'}
          disabled={working}
          onPress={() => act('prove', () => business.prove())}
        />
      </View>

      {message}

      {t.activity.length > 0 ? (
        <>
          <Eyebrow small style={{ marginTop: space.s22 }}>
            Activity
          </Eyebrow>
          {t.activity.map((a, i) => (
            <View
              key={`${a.at}-${i}`}
              style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.s12, marginTop: space.s12 }}
            >
              <Text variant="rowPrimary" style={{ flex: 1 }}>
                {plainAction(a.action)}
              </Text>
              <Text variant="secondarySm" color={colors.ink55}>
                {when(a.at)}
              </Text>
            </View>
          ))}
        </>
      ) : null}
    </>
  );
}

function Fact({ title, detail, alarm }: { title: string; detail: string; alarm?: boolean }) {
  return (
    <View>
      <Text variant="rowPrimary">{title}</Text>
      <Text variant="secondarySm" color={alarm ? colors.down : colors.ink55} style={{ marginTop: space.s2 }}>
        {detail}
      </Text>
    </View>
  );
}
