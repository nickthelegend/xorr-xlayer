/**
 * One agent (2026-09-12): who it is, money in and out, and what it runs.
 *
 * Rebuilt to the product owner's brief — the agent's money, the strategies it runs and a way to add one — with
 * the long caveats taken off the page. Since 2026-09-25 its money is its on-chain budget, set here; the wallet's
 * own Deposit and Withdraw are Home's. The identity glyph is the same one the roster draws.
 *
 * Which strategies are "its": strategies are not tagged by agent in the data, so this reads the
 * strategy kind each agent's mandate covers — breakouts for Momentum Scout, earnings events for
 * Earnings Desk, idle cash for Yield Keeper, exits for Drawdown Guard — and lists this wallet's
 * strategies of that kind. The mapping is the mandate, written down; it attributes no run to anyone.
 *
 * "Add strategy" goes where the ladder says that kind is set up, and appears only when something in
 * the app can set it up. It sent Momentum Scout and Earnings Desk to /strategies, where neither kind
 * can be created, so those two say they have nothing to add. The full list is still one tap away, from
 * the card's own header: this page is how people reach it.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  AgentOrb,
  BackButton,
  Button,
  ErrorState,
  Placeholder,
  Press,
  Price,
  Row,
  Screen,
  Text,
  colors,
  money,
  pnlTone,
  radius,
  size,
  space,
  type PriceTone,
} from '@/ui';
import { Rise } from '@/ui/Rise';
import { agentGradient } from '@/design/gradients';
import { useAsync } from '@/data/useAsync';
import { repos } from '@/data';
import { errorText } from '@/data/apiError';
import { winRate } from '@/state/derived';
import { labelFigure, setupFor } from '@/strategies/ladder';
import type { StrategyKind } from '@/data/types';
import { CHAT_AGENTS } from '@/chat/agents';
import { AgentBudgetCard } from '@/wallet/AgentBudgetCard';

/** The strategy kind each agent's mandate covers. See the header comment. */
const MANDATE_KINDS: Readonly<Record<string, readonly StrategyKind[]>> = {
  'Momentum Scout': ['momentum'],
  'Earnings Desk': ['event-driven'],
  'Yield Keeper': ['yield-rotation'],
  'Drawdown Guard': ['exit-rules'],
};

const STATE_LABEL: Readonly<Record<string, string>> = {
  live: 'Live',
  watch: 'Watching',
  paused: 'Paused',
  draft: 'Draft',
  ended: 'Ended',
};

const ORB = 84 as const;

export default function AgentDetail() {
  const goBack = useGoBack();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [hiring, setHiring] = useState(false);
  const [hireError, setHireError] = useState<string>();
  /*
   * A hire that went through ON THIS VISIT, for the orb's `filled` beat.
   *
   * Not `agent.hired`: that is true for every visit afterwards, and an orb that pops every time the page
   * opens is celebrating something that happened last week. The beat belongs to the moment it lands.
   */
  const [justHired, setJustHired] = useState(false);

  // `listAgents` throws when /agents cannot answer, so a failed read reaches the ErrorState below
  // rather than passing for an agent with a record of zeros. Signed out, that asks for a sign-in.
  const agents = useAsync(() => repos.bot.listAgents(), []);
  const strategies = useAsync(() => repos.strategies.list(), []);

  const agent = (agents.data ?? []).find((a) => a.id === id || a.personaId === id);
  // An agent someone made runs the kind of strategy the one it works like does.
  const mandateOf = agent?.custom ? CHAT_AGENTS.find((a) => a.id === agent.style)?.name : agent?.name;
  const kinds = mandateOf ? (MANDATE_KINDS[mandateOf] ?? []) : [];
  // Plain: the React Compiler memoizes this itself, and could not preserve a hand-written memo keyed
  // on a joined string.
  // Its own strategies by id, and — for one of the four — the kind its mandate covers as well (2026-09-25: a buy given to
  // Momentum Scout by id showed "Nothing running yet" on its page).
  const mine = (strategies.data ?? []).filter(
    (s) => s.state !== 'ended' && (s.agentId === agent?.id || (!agent?.custom && kinds.includes(s.kind))),
  );
  const setup = setupFor(kinds);

  const hire = async () => {
    if (!agent) return;
    setHiring(true);
    setHireError(undefined);
    try {
      await repos.bot.hire(agent.personaId ?? agent.id);
      setJustHired(true);
      agents.reload();
    } catch (e) {
      /*
       * The server's sentence, under the button that asked.
       *
       * There was no catch: a refused hire stopped the spinner and changed nothing else, which reads
       * as a hire that went through — until the chip still says NOT HIRED.
       */
      setHireError(errorText(e));
    } finally {
      setHiring(false);
    }
  };

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <BackButton onPress={goBack} />
      </View>

      {agents.error ? (
        <View style={{ paddingHorizontal: space.gutter }}>
          <ErrorState error={agents.error} onRetry={agents.reload} />
        </View>
      ) : !agent && agents.loading ? (
        <View style={{ alignItems: 'center', gap: space.s12, paddingHorizontal: space.gutter, marginTop: space.s8 }}>
          <Placeholder width={ORB} height={ORB} style={{ borderRadius: radius.full }} />
          <Placeholder width={180} height={24} />
          <Placeholder width={220} height={14} />
          <View style={{ flexDirection: 'row', gap: space.s10, alignSelf: 'stretch', marginTop: space.s12 }}>
            <Placeholder width="48%" height={54} />
            <Placeholder width="48%" height={54} />
          </View>
          <Placeholder height={180} style={{ marginTop: space.s12 }} />
        </View>
      ) : !agent ? (
        <View style={{ paddingHorizontal: space.gutter }}>
          <Text variant="body" color={colors.ink55}>
            Agent not found.
          </Text>
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.s30, gap: space.s14 }}
        >
          <Rise index={0} style={{ alignItems: 'center', gap: space.s8 }}>
            {/*
              What the agent is doing, from this screen's own state (`AgentOrb`'s `stage`): the hire is out for
              the executor to answer, or it has just answered. An agent that was already hired when the page
              opened is still — nothing is happening, and the HIRED chip below says the rest.
            */}
            <AgentOrb
              gradient={agentGradient(agent.name)}
              identity={agent.name}
              size={ORB}
              face
              stage={hiring ? 'executing' : justHired ? 'filled' : undefined}
            />
            <Text variant="screenTitle" align="center" style={{ marginTop: space.s6 }}>
              {agent.name}
            </Text>
            <Text variant="secondarySm" color={colors.ink55} align="center">
              {agent.role}
            </Text>
            <View
              style={{
                marginTop: space.s4,
                paddingHorizontal: space.s10,
                paddingVertical: space.s2,
                borderRadius: radius.full,
                backgroundColor: agent.hired ? colors.control : colors.neutralBg,
              }}
            >
              <Text variant="chipSm" color={agent.hired ? colors.ink : colors.ink55}>
                {agent.hired ? 'HIRED' : 'NOT HIRED'}
              </Text>
            </View>
          </Rise>

          {!agent.hired ? (
            <Rise index={1} style={{ gap: space.s8 }}>
              <Button label={`Hire ${agent.name}`} onPress={hire} loading={hiring} />
              {hireError ? (
                <Text variant="secondarySm" color={colors.down} align="center">
                  {hireError}
                </Text>
              ) : null}
            </Rise>
          ) : null}

          {/*
            Its own budget, on chain (2026-09-25), first under its name: this is the agent's money. Only an agent this
            wallet has — hired or made — has a key to file one under. "Add funds" and "Withdraw" sat here and opened the
            wallet's own Deposit and Send, which read as if the agent had a wallet of its own; it has a budget, and the
            wallet stays yours, one tap away on Home.
          */}
          {agent.onChainKey ? (
            <Rise index={1}>
              <AgentBudgetCard
                agentId={agent.id}
                name={agent.name}
                budgetUsd={agent.budgetUsd ?? null}
                onChanged={agents.reload}
              />
            </Rise>
          ) : null}

          <Rise index={2} style={{ flexDirection: 'row', gap: space.s10 }}>
            <Stat label="30 days" value={money(agent.pnl30d)} tone={pnlTone(agent.pnl30d)} />
            {/* A share of trades: with none there is no rate, and "0%" read as every trade lost. */}
            <Stat label="Win rate" value={winRate(agent)} />
            <Stat label="Trades" value={String(agent.trades)} />
          </Rise>

          <Rise index={3} style={{ borderRadius: radius.panel, backgroundColor: colors.surfaceAlt, padding: space.s16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text variant="cardTitle">Strategies</Text>
              <Press
                onPress={() => router.push('/strategies')}
                accessibilityRole="button"
                accessibilityLabel="See all strategies"
                hitHeight={size.hit}
              >
                <Text variant="control" color={colors.ink55}>
                  See all
                </Text>
              </Press>
            </View>
            {strategies.loading && !strategies.data ? (
              <View style={{ marginTop: space.s12, gap: space.s10 }}>
                <Placeholder height={48} />
                <Placeholder height={48} />
              </View>
            ) : mine.length === 0 ? (
              <Text variant="body" color={colors.ink55} style={{ marginTop: space.s10 }}>
                {strategies.error ? 'Couldn’t load strategies.' : 'Nothing running yet.'}
              </Text>
            ) : (
              mine.map((s, i) => (
                <Row
                  key={s.id}
                  height={size.rowLg}
                  divider={i < mine.length - 1}
                  onPress={() => router.push(`/strategy/${s.id}`)}
                  title={s.label}
                  titleFigure={labelFigure(s.kind)}
                  secondary={`${s.symbol} · ${money(s.dailyAllocationUsd)} a day`}
                  value={
                    <Text variant="secondarySm" color={s.state === 'live' ? colors.ink : colors.ink40}>
                      {STATE_LABEL[s.state] ?? s.state}
                    </Text>
                  }
                />
              ))
            )}
            {setup ? (
              <View style={{ marginTop: space.s14 }}>
                <Button label="Add strategy" variant="ghost" onPress={() => router.push(setup.route as never)} />
              </View>
            ) : (
              <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s14 }}>
                No strategy to add for {agent.name} yet.
              </Text>
            )}
          </Rise>
        </ScrollView>
      )}
    </Screen>
  );
}

/** One figure in the stats row. */
function Stat({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: PriceTone }) {
  return (
    <View
      style={{
        flex: 1,
        paddingVertical: space.s14,
        paddingHorizontal: space.s12,
        borderRadius: radius.card,
        backgroundColor: colors.surfaceAlt,
      }}
    >
      {/* Shrinks to fit rather than truncating: "$0...." is not a figure. */}
      <Price variant="cardTitleLg" tone={tone} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
        {value}
      </Price>
      <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s4 }}>
        {label}
      </Text>
    </View>
  );
}
