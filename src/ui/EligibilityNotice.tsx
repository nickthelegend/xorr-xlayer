/**
 * EligibilityNotice.tsx — why a buy is not on offer.
 *
 * xStocks are jurisdiction-restricted tokenized equities. When the issuer's own gates refuse a
 * wallet, the useful thing is the sentence, not a disabled button with no explanation — and the
 * sentence has to distinguish "the issuer has refused this" from "we could not find out", because
 * the second one is a problem the user may simply retry.
 *
 * `warn` throughout: §7 keeps the P&L colours for outcomes, and a compliance gate is not a loss.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Tag } from './Tag';
import { Text } from './Text';
import { colors, space } from './tokens';
import type { Eligibility } from '../data/eligibility';

export function EligibilityNotice({
  eligibility,
  style,
  testID,
}: {
  /** `undefined` while the gates are still being read. */
  eligibility?: Eligibility;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  if (!eligibility) {
    return <Tag label="Checking eligibility" tone="neutral" small style={style} testID={testID} />;
  }
  if (eligibility.eligible) return null;

  return (
    <View testID={testID} style={[{ gap: space.s6 }, style]}>
      <Tag
        label={eligibility.indeterminate ? 'Eligibility unknown' : 'Not available to this wallet'}
        tone="warn"
        small
      />
      <Text variant="footnoteSm" color={colors.ink50}>
        {eligibility.summary}
      </Text>
    </View>
  );
}

/**
 * The issuer's gates, itemised.
 *
 * `not-configured` is deliberately its own word rather than a tick: a gate the issuer never set up
 * is not a gate this wallet passed, and rendering both as a checkmark is precisely the overclaim
 * this screen exists to avoid.
 */
export function EligibilityChecks({ eligibility }: { eligibility?: Eligibility }) {
  if (!eligibility || eligibility.checks.length === 0) return null;

  /*
   * Words, not ticks. §7 wants information that survives colour blindness, and "not configured"
   * has no glyph that does not read as either a pass or a failure — which is the one distinction
   * this list exists to hold open.
   */
  const MARK: Record<string, { label: string; color: string }> = {
    pass: { label: 'OK', color: colors.up },
    blocked: { label: 'BLOCKED', color: colors.warn },
    unknown: { label: 'UNKNOWN', color: colors.ink50 },
    'not-configured': { label: 'NONE SET', color: colors.ink50 },
  };

  return (
    <View style={{ gap: space.s8 }}>
      {eligibility.checks.map((c) => {
        const m = MARK[c.status]!;
        return (
          <View key={c.id} style={{ flexDirection: 'row', gap: space.s8 }}>
            <Text variant="tagSm" color={m.color} style={{ width: 62 }}>
              {m.label}
            </Text>
            <View style={{ flex: 1, gap: space.s2 }}>
              <Text variant="footnoteSm" color={colors.ink}>
                {c.title}
              </Text>
              <Text variant="footnoteSm" color={colors.ink50}>
                {c.detail}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}
