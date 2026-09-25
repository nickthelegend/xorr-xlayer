/**
 * One agent's budget, as the contract holds it, and the owner's hand on it (2026-09-25).
 *
 * The figure is the chain's: what `GET /agents` read from the contract, and after a change what the chain answered once
 * the transaction landed — never the amount that was typed. Setting it is a transaction the owner signs. Zero stops the
 * agent's buys; a sale of something it bought still settles, and its proceeds go back to the budget, as any sale's do —
 * so to stop an agent for good, fire it.
 *
 * Laid out as the agent's money (redesigned the same day): the figure first, what it means in one line, then one way to
 * change it — a preset or a custom amount, and a single button that says exactly what will be signed.
 */
import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import {
  Button,
  ChoiceChip,
  Press,
  Price,
  Text,
  TransactionRef,
  border,
  colors,
  money,
  radius,
  size,
  space,
  typeScale,
} from '@/ui';
import { activeChain, chainMoney } from '@/chain';
import { budgetProblem } from './agentBudget';
import { useAgentBudget } from './useAgentBudget';

const PRESETS = ['25', '50', '100'] as const;
const FIELD_H = 48;
const DOT = 6;

/** Where a person can look the transaction up: a link on a public chain, the hash alone on a fork (`TransactionRef`). */
function explorerRef(txHash: string): string {
  const base = activeChain.blockExplorers?.default.url;
  return base && chainMoney !== 'copy' ? `${base}/tx/${txHash}` : `fork:${txHash}`;
}

export function AgentBudgetCard({
  agentId,
  name,
  budgetUsd,
  onChanged,
}: {
  agentId: string;
  name: string;
  /** What the executor read from the contract; null when that read failed. */
  budgetUsd: number | null;
  onChanged?: () => void;
}) {
  const { setBudget, busy, error } = useAgentBudget();
  const [typed, setTyped] = useState('');
  // A custom amount is typed; a preset is one tap. The field appears only when asked for.
  const [custom, setCustom] = useState(false);
  // The chain's answer after a change on this visit, until the roster is read again.
  const [after, setAfter] = useState<{ budgetUsd: number; explorer: string }>();
  const shown = after?.budgetUsd ?? budgetUsd;
  const problem = typed ? budgetProblem(typed) : undefined;
  const ready = typed !== '' && !problem;

  const submit = async (value: string) => {
    try {
      const out = await setBudget(agentId, value);
      setAfter({ budgetUsd: out.budgetUsd, explorer: explorerRef(out.txHash) });
      setTyped('');
      setCustom(false);
      onChanged?.();
    } catch {
      // The hook keeps the sentence; it is shown under the button.
    }
  };

  return (
    <View
      testID="agent-budget"
      style={{ borderRadius: radius.panel, backgroundColor: colors.surfaceAlt, padding: space.s18 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="cardTitle">Budget</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s6 }}>
          <View
            style={{
              width: DOT,
              height: DOT,
              borderRadius: DOT / 2,
              backgroundColor: shown === null ? colors.warn : colors.up,
            }}
          />
          <Text variant="secondarySm" color={colors.ink55}>
            Held on chain
          </Text>
        </View>
      </View>

      <Price variant="amountLg" testID="agent-budget-figure" style={{ marginTop: space.s12 }}>
        {shown === null ? '—' : money(shown)}
      </Price>
      <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s4 }}>
        {shown === null
          ? 'Couldn’t read it from the chain just now.'
          : shown > 0
            ? `Left for ${name} to spend. Its buys come out of this, and the contract refuses anything past it.`
            : `${name} can’t buy until it has one. Its sales still settle, and put their proceeds back here.`}
      </Text>

      <View style={{ height: 1, backgroundColor: colors.hairline, marginVertical: space.s16 }} />

      <Text variant="secondarySm" color={colors.ink55}>
        {shown !== null && shown > 0 ? 'Change it' : 'Give it a budget'}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s8, marginTop: space.s10 }}>
        {PRESETS.map((p) => (
          <ChoiceChip
            key={p}
            label={`$${p}`}
            selected={!custom && typed === p}
            onPress={() => {
              setCustom(false);
              setTyped(p);
            }}
          />
        ))}
        <ChoiceChip
          label="Custom"
          selected={custom}
          onPress={() => {
            setCustom(true);
            setTyped('');
          }}
        />
      </View>
      {custom ? (
        <TextInput
          value={typed}
          onChangeText={setTyped}
          placeholder="Amount in dollars"
          placeholderTextColor={colors.ink35}
          keyboardType="decimal-pad"
          autoCorrect={false}
          autoFocus
          accessibilityLabel={`${name}'s budget in dollars`}
          testID="agent-budget-input"
          style={[
            typeScale.body,
            border.input,
            {
              height: FIELD_H,
              marginTop: space.s10,
              borderRadius: radius.tile,
              backgroundColor: colors.inputBg,
              paddingHorizontal: space.s14,
              color: colors.ink,
            },
          ]}
        />
      ) : null}
      {problem ? (
        <Text variant="secondarySm" color={colors.down} style={{ marginTop: space.s8 }}>
          {problem}
        </Text>
      ) : null}

      <View style={{ marginTop: space.s14 }}>
        <Button
          label={ready ? `Set budget to ${money(Number(typed))}` : 'Choose an amount'}
          onPress={() => void submit(typed)}
          disabled={!ready}
          loading={busy}
        />
      </View>

      {error ? (
        <Text variant="secondarySm" color={colors.down} style={{ marginTop: space.s10 }}>
          {error}
        </Text>
      ) : null}
      {after ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: space.s12,
          }}
        >
          <Text variant="footnote" color={colors.up}>
            Set on chain.
          </Text>
          <TransactionRef explorer={after.explorer} />
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s12, marginTop: space.s12 }}>
        <Text variant="footnote" color={colors.ink40} style={{ flex: 1 }}>
          Your wallet signs it. The bot’s key can’t change it.
        </Text>
        {shown !== null && shown > 0 ? (
          <Press
            onPress={() => void submit('0')}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`Set ${name}'s budget to zero`}
            hitHeight={size.hit}
          >
            <Text variant="control" color={colors.ink55}>
              Set to $0
            </Text>
          </Press>
        ) : null}
      </View>
    </View>
  );
}
