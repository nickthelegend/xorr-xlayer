/**
 * Screen 7 — Goals & risk. screens.md Group A.
 *
 * Back circle + 4pt progress track + step counter. Title 26/700 two lines. Subtitle.
 * Wrapping chip row (gap 9, chips 40 tall, radius 22). A drawdown question with a 3-up
 * segmented (42pt thumbs). Summary line above Continue.
 *
 * The answers are persisted on the device and read nowhere else yet, so the screen claims nothing
 * about what they do. See the note where the drawdown caption used to be.
 */
import React from 'react';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  ChoiceChip,
  Fill,
  PillWrap,
  Progress,
  Screen,
  Segmented,
  Text,
  colors,
  size,
  space,
} from '@/ui';
import { onboarding } from '@/data/fixtures/onboarding';
import { useStore } from '@/state/store';

const RISK_OPTIONS = onboarding.riskLevels.map((label, value) => ({ value, label }));

export default function Goals() {
  const router = useRouter();
  const goBack = useGoBack();
  const goals = useStore((s) => s.goals);
  const toggleGoal = useStore((s) => s.toggleGoal);
  const riskQ = useStore((s) => s.riskQ);
  const setRiskQ = useStore((s) => s.setRiskQ);
  const risk = onboarding.riskLevels[riskQ] ?? 'Balanced';

  return (
    <Screen>
      <Progress step={1} total={3} onBack={() => goBack()} />

      <Text variant="onboardingTitle" style={{ marginTop: space.s26 }}>
        {'What should your\nbot optimise for?'}
      </Text>
      <Text variant="body" color={colors.ink55} style={{ marginTop: space.s10 }}>
        Pick any.
      </Text>

      <PillWrap style={{ marginTop: space.s20 }}>
        {onboarding.goals.map((g) => (
          <ChoiceChip
            key={g}
            label={g}
            selected={goals.includes(g)}
            onPress={() => toggleGoal(g)}
          />
        ))}
      </PillWrap>

      <Text variant="cardTitle" style={{ marginTop: space.s30 }}>
        How much drawdown can you sit through?
      </Text>
      <Segmented
        options={RISK_OPTIONS}
        value={riskQ}
        onChange={setRiskQ}
        height={size.segThumbLg}
        style={{ marginTop: space.s14 }}
      />
      {/*
        No caption under the drawdown pick. It read "{Balanced} caps single-position size and how far a stop can sit
        from entry", and nothing does: these answers are kept on this phone and no proposal, strategy or limit reads
        them. The limits that do bind are set two screens on, and signed.
      */}

      <Fill />

      <Text variant="footnote" color={colors.ink55} style={{ marginBottom: space.s12 }}>
        {goals.length} selected · {risk}
      </Text>
      <Button
        label="Continue"
        disabled={goals.length === 0}
        onPress={() => router.push('/wallet')}
      />
    </Screen>
  );
}
