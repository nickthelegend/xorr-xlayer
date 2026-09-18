/**
 * New agent (2026-09-16): make an agent of your own, and give it strategies to run.
 *
 * A name, what it is for in your own words, and which of the four it works like — the persona whose voice it speaks in —
 * with an optional daily limit the executor holds it to on every run. Then the strategies it runs, picked on their own
 * screen (`app/agent/strategies.tsx`) from every one the executor can run here, each with what it did over the last 90
 * days of real prices; what is picked shows here, each removable, with the amount each run spends.
 *
 * Made on the executor (`POST /agents/custom`), hired as it is made; each picked strategy is created for it
 * (`POST /strategies` with its `agentId`), and its page opens. A strategy the executor refuses — no permission yet, a
 * daily cap — says why here, with the agent already made, and can be tried again or left for later.
 *
 * Reached from the + on Home's agents, from Messages, and from the roster.
 */
import React, { useEffect, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  AgentOrb,
  BackButton,
  Button,
  Eyebrow,
  Fill,
  Press,
  RadioCard,
  Screen,
  SignInPrompt,
  Text,
  border,
  colors,
  radius,
  space,
  typeScale,
} from '@/ui';
import { Icon } from '@/design/Icon';
import { agentGradient } from '@/design/gradients';
import { CHAT_AGENTS, useMadeAgents } from '@/chat/agents';
import { useSignedOut } from '@/auth/useSignedOut';
import { repos } from '@/data';
import { errorText } from '@/data/apiError';
import { usePrices } from '@/data/usePrices';
import { ReplayLine } from '@/strategies/ReplayLine';
import {
  PRICED,
  STRATEGY_TEMPLATES,
  marksOf,
  useAgentStrategies,
  useStrategyReplays,
} from '@/strategies/agentStrategies';
import type { Agent } from '@/data/types';

const ORB = 84 as const;
const FIELD_H = 48;
const REMOVE_HIT = 44;
/** The executor's bounds (`server/src/agents/routes.ts`), so nothing typed here is refused for its length there. */
const NAME_MIN = 2;
const NAME_MAX = 24;
const ROLE_MIN = 3;
const ROLE_MAX = 80;
/** What each run of a picked strategy spends, until it is changed. */
const DEFAULT_EACH_RUN = '25';

export default function NewAgent() {
  const goBack = useGoBack();
  const router = useRouter();
  const signedOut = useSignedOut();
  const addMade = useMadeAgents((s) => s.add);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [style, setStyle] = useState<string>(CHAT_AGENTS[0]!.id);
  const [limit, setLimit] = useState('');
  const [eachRun, setEachRun] = useState(DEFAULT_EACH_RUN);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** Set once the agent exists, so trying the strategies again does not make it twice. */
  const [made, setMade] = useState<Agent>();

  const { quotes } = usePrices(PRICED);
  const marks = marksOf(quotes);
  // Started here, so the picker opens on replays already on their way.
  useStrategyReplays(marks, !signedOut);
  const chosen = useAgentStrategies((s) => s.chosen);
  const replays = useAgentStrategies((s) => s.replays);
  const toggle = useAgentStrategies((s) => s.toggle);
  const unchoose = useAgentStrategies((s) => s.unchoose);
  const clear = useAgentStrategies((s) => s.clear);
  const forgetFailures = useAgentStrategies((s) => s.forgetFailures);
  // A fresh pick for each agent: what was picked for the last one is not carried into the next.
  useEffect(() => {
    forgetFailures();
    return clear;
  }, [forgetFailures, clear]);

  const picked = STRATEGY_TEMPLATES.filter((t) => chosen.has(t.key));
  const shownName = name.trim();
  const limitUsd = limit.trim() === '' ? undefined : Number(limit);
  const limitOk = limitUsd === undefined || (Number.isFinite(limitUsd) && limitUsd > 0);
  const eachRunUsd = Number(eachRun);
  const eachRunOk = picked.length === 0 || (Number.isFinite(eachRunUsd) && eachRunUsd > 0);
  const ready = shownName.length >= NAME_MIN && role.trim().length >= ROLE_MIN && limitOk && eachRunOk && !busy;

  const openAgent = (agent: Agent) => router.replace({ pathname: '/agent/[id]', params: { id: agent.id } });

  async function make() {
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    try {
      let agent = made;
      if (!agent) {
        agent = await repos.bot.createAgent({
          name: shownName,
          role: role.trim(),
          style,
          ...(limitUsd !== undefined ? { riskLimits: { maxUsdPerDay: limitUsd } } : {}),
        });
        addMade(agent);
        setMade(agent);
      }
      // Never more a run than the agent may spend in a day.
      const usd = limitUsd !== undefined ? Math.min(eachRunUsd, limitUsd) : eachRunUsd;
      const refused: string[] = [];
      const added: string[] = [];
      for (const t of picked) {
        if (t.needs && !marks[t.needs]) {
          refused.push(`${t.title}: today’s price is not in yet, so its levels cannot be drawn.`);
          continue;
        }
        try {
          await repos.strategies.create({ ...t.build(usd, marks), agentId: agent.id });
          added.push(t.key);
        } catch (e) {
          refused.push(`${t.title}: ${errorText(e)}`);
        }
      }
      if (refused.length === 0) {
        openAgent(agent);
        return;
      }
      // What went through is not asked for twice.
      unchoose(added);
      setError(`${agent.name} is made. ${refused.join(' ')}`);
    } catch (e) {
      // The executor's sentence: a name already taken says so, and says what to do.
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
      <BackButton onPress={() => goBack()} />
      <Text variant="screenTitle">New agent</Text>
    </View>
  );

  if (signedOut) {
    return (
      <Screen>
        {header}
        <SignInPrompt text="Sign in to make an agent." />
      </Screen>
    );
  }

  const strategiesWord = picked.length === 1 ? 'strategy' : 'strategies';

  return (
    <Screen>
      {header}
      <Fill style={{ marginTop: space.s12 }}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingTop: space.s6, paddingBottom: space.s20, gap: space.s18 }}
        >
          {/* The agent as it will look: its face and colour come from its name, as it is typed. */}
          <View style={{ alignItems: 'center', gap: space.s8 }}>
            <AgentOrb gradient={agentGradient(shownName || 'New agent')} identity={shownName || 'New agent'} size={ORB} face />
            <Text variant="cardTitle" align="center" numberOfLines={1} color={shownName ? colors.ink : colors.ink40}>
              {shownName || 'Your agent'}
            </Text>
          </View>

          <Field
            label="Name"
            value={name}
            onChange={setName}
            placeholder="Dip Buyer"
            maxLength={NAME_MAX}
            capitalize="words"
            editable={!made}
          />
          <Field
            label="What it does"
            value={role}
            onChange={setRole}
            placeholder="Buys ETH on red days"
            maxLength={ROLE_MAX}
            capitalize="sentences"
            editable={!made}
          />

          <View style={{ gap: space.s10 }}>
            <Eyebrow small>Works like</Eyebrow>
            {CHAT_AGENTS.map((a) => (
              <RadioCard
                key={a.id}
                title={a.name}
                detail={a.role}
                selected={style === a.id}
                onPress={() => {
                  if (!made) setStyle(a.id);
                }}
              />
            ))}
          </View>

          <View style={{ gap: space.s10 }}>
            <Eyebrow small>{picked.length > 0 ? `Strategies · ${picked.length}` : 'Strategies'}</Eyebrow>
            {picked.length === 0 ? (
              <Text variant="secondarySm" color={colors.ink55}>
                What it runs. Pick any of them, or all — each shows what it did over the last 90 days of real prices.
              </Text>
            ) : (
              picked.map((t) => (
                <View
                  key={t.key}
                  style={[
                    {
                      backgroundColor: colors.surface,
                      borderRadius: radius.panel,
                      paddingVertical: space.s12,
                      paddingLeft: space.s16,
                      paddingRight: space.s8,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.s8,
                    },
                    border.card,
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text variant="rowPrimary" numberOfLines={1}>
                      {t.title}
                    </Text>
                    <ReplayLine template={t} replay={replays[t.key]} marks={marks} />
                  </View>
                  <Press
                    onPress={() => toggle(t.key)}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${t.title}`}
                    hitWidth={REMOVE_HIT}
                    hitHeight={REMOVE_HIT}
                    style={{ width: REMOVE_HIT, height: REMOVE_HIT, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Icon name="close" size={16} color={colors.ink55} />
                  </Press>
                </View>
              ))
            )}
            <Button
              label={picked.length > 0 ? 'Change strategies' : 'Pick strategies'}
              variant="ghost"
              onPress={() => router.push('/agent/strategies')}
            />
          </View>

          {picked.length > 0 ? (
            <Field
              label="Each run"
              value={eachRun}
              onChange={(v) => setEachRun(v.replace(/[^0-9.]/g, ''))}
              placeholder="$ a run"
              keyboard="decimal-pad"
            />
          ) : null}

          <Field
            label="Daily limit · optional"
            value={limit}
            onChange={(v) => setLimit(v.replace(/[^0-9.]/g, ''))}
            placeholder="$ a day"
            keyboard="decimal-pad"
            editable={!made}
          />

          {error ? (
            <Text variant="secondarySm" color={colors.down}>
              {error}
            </Text>
          ) : null}
        </ScrollView>
      </Fill>

      {made ? (
        <View style={{ gap: space.s8 }}>
          {picked.length > 0 ? (
            <Button
              label={busy ? 'Adding' : `Add ${picked.length} ${strategiesWord}`}
              loading={busy}
              disabled={!ready}
              onPress={() => void make()}
            />
          ) : null}
          <Button label={`Open ${made.name}`} variant="ghost" onPress={() => openAgent(made)} />
        </View>
      ) : (
        <Button
          label={busy ? 'Making' : picked.length > 0 ? `Make agent · ${picked.length} ${strategiesWord}` : 'Make agent'}
          loading={busy}
          disabled={!ready}
          onPress={() => void make()}
        />
      )}
    </Screen>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  capitalize = 'none',
  keyboard = 'default',
  editable = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  maxLength?: number;
  capitalize?: 'none' | 'words' | 'sentences';
  keyboard?: 'default' | 'decimal-pad';
  editable?: boolean;
}) {
  return (
    <View style={{ gap: space.s8 }}>
      <Eyebrow small>{label}</Eyebrow>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.ink35}
        maxLength={maxLength}
        autoCapitalize={capitalize}
        autoCorrect={false}
        keyboardType={keyboard}
        editable={editable}
        accessibilityLabel={label}
        style={[
          typeScale.body,
          border.input,
          {
            height: FIELD_H,
            borderRadius: radius.tile,
            backgroundColor: colors.inputBg,
            paddingHorizontal: space.s14,
            color: editable ? colors.ink : colors.ink55,
          },
        ]}
      />
    </View>
  );
}
