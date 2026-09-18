/**
 * BackingBadge.tsx — whether an xStock is backed by the share it represents.
 *
 * Three states, and the third is the point: backed, under-backed, and NOT KNOWN. The last one is
 * drawn as plainly as the other two rather than hidden, because a badge that quietly disappears
 * when the attestor is unreachable teaches a reader that its absence means nothing — and then a
 * missing badge and an unbacked token look identical.
 *
 * `warn` rather than `down` for unverified: §7 reserves the P&L colours for outcomes, and not
 * having read the attestation is not a loss. Under-backed IS an outcome, and gets `down`.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Tag } from './Tag';
import { Text } from './Text';
import { colors, space } from './tokens';
import { backingLabel, type Backing } from '../data/backing';

export function BackingBadge({
  backing,
  style,
  testID,
}: {
  /** `undefined` while the attestation is still being read. */
  backing?: Backing;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  if (!backing) {
    return <Tag label="Checking backing" tone="neutral" small style={style} testID={testID} />;
  }
  if (!backing.verified) {
    return <Tag label="Backing unverified" tone="warn" small style={style} testID={testID} />;
  }
  return (
    <Tag
      label={backingLabel(backing)}
      tone={backing.fullyBacked ? 'up' : 'down'}
      small
      style={style}
      testID={testID}
    />
  );
}

/**
 * The badge with the number under it, for a position row that has the space.
 *
 * The ratio is shown to four decimals because three rounds 1.0001 to "1.000" and makes a real
 * margin look like exactly none.
 */
export function BackingLine({ backing, testID }: { backing?: Backing; testID?: string }) {
  return (
    <View testID={testID} style={{ gap: space.s4 }}>
      <BackingBadge backing={backing} />
      {backing?.verified ? (
        <Text variant="footnoteSm" color={colors.ink50}>
          {`${backing.ratio.toFixed(4)}x · ${
            backing.custodians[0]?.provider ?? 'custodian undisclosed'
          }`}
        </Text>
      ) : backing ? (
        <Text variant="footnoteSm" color={colors.ink50} numberOfLines={2}>
          {backing.reason}
        </Text>
      ) : null}
    </View>
  );
}
