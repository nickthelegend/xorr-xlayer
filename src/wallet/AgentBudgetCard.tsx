/**
 * One agent's budget, as the contract holds it, and the owner's hand on it (2026-09-25).
 *
 * The figure is the chain's: what `GET /agents` read from the contract, and after a change what the chain answered once
 * the transaction landed — never the amount that was typed. Setting it is a transaction the owner signs; zero takes the
 * budget away, and the contract then refuses anything the agent tries.
 */
import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { Button, ChoiceChip, Price, Text, TransactionRef, border, colors, money, radius, space, typeScale } from '@/ui';
import { activeChain, chainMoney } from '@/chain';
import { budgetProblem } from './agentBudget';
import { useAgentBudget } from './useAgentBudget';

const PRESETS = ['25', '50', '100'] as const;
const FIELD_H = 48;

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
  // The chain's answer after a change on this visit, until the roster is read again.
  const [after, setAfter] = useState<{ budgetUsd: number; explorer: string }>();
  const shown = after?.budgetUsd ?? budgetUsd;
  const problem = typed ? budgetProblem(typed) : undefined;

  const submit = async (value: string) => {
    try {
      const out = await setBudget(agentId, value);
      setAfter({ budgetUsd: out.budgetUsd, explorer: explorerRef(out.txHash) });
      setTyped('');
      onChanged?.();
    } catch {
      // The hook keeps the sentence; it is shown under the button.
    }
  };

  return (
    <View
      testID="agent-budget"
      style={{ borderRadius: radius.panel, backgroundColor: colors.surfaceAlt, padding: space.s16, gap: space.s10 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="cardTitle">Budget</Text>
        <Text variant="secondarySm" color={colors.ink55}>
          Held on chain
        </Text>
      </View>

      <Price variant="cardTitleLg" testID="agent-budget-figure">
        {shown === null ? '—' : money(shown)}
      </Price>
      <Text variant="secondarySm" color={colors.ink55}>
        {shown === null
          ? 'Couldn’t read it from the chain just now.'
          : shown > 0
            ? `What ${name} may still spend. The contract takes its buys out of this and puts its sales back, and refuses any trade past it.`
            : `${name} has no budget, so the contract refuses any trade it tries. Give it one, and it can trade.`}
      </Text>

      <View style={{ flexDirection: 'row', gap: space.s8, marginTop: space.s4 }}>
        {PRESETS.map((p) => (
          <ChoiceChip key={p} label={`$${p}`} selected={typed === p} onPress={() => setTyped(p)} />
        ))}
      </View>
      <TextInput
        value={typed}
        onChangeText={setTyped}
        placeholder="Or type an amount in dollars"
        placeholderTextColor={colors.ink35}
        keyboardType="decimal-pad"
        autoCorrect={false}
        accessibilityLabel={`${name}'s budget in dollars`}
        testID="agent-budget-input"
        style={[
          typeScale.body,
          border.input,
          {
            height: FIELD_H,
            borderRadius: radius.tile,
            backgroundColor: colors.inputBg,
            paddingHorizontal: space.s14,
            color: colors.ink,
          },
        ]}
      />
      {problem ? (
        <Text variant="secondarySm" color={colors.down}>
          {problem}
        </Text>
      ) : null}

      <Button
        label={typed && !problem ? `Set budget to ${money(Number(typed))}` : 'Set budget'}
        onPress={() => void submit(typed)}
        disabled={!typed || Boolean(problem)}
        loading={busy}
      />
      {shown !== null && shown > 0 ? (
        <Button label="Take its budget away" variant="ghost" onPress={() => void submit('0')} disabled={busy} />
      ) : null}

      {error ? (
        <Text variant="secondarySm" color={colors.down}>
          {error}
        </Text>
      ) : null}
      {after ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text variant="footnote" color={colors.ink55}>
            Set on chain.
          </Text>
          <TransactionRef explorer={after.explorer} />
        </View>
      ) : null}
      <Text variant="footnote" color={colors.ink55}>
        You sign this with your own wallet. The bot’s key cannot change it.
      </Text>
    </View>
  );
}
