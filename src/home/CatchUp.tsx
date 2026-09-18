/**
 * What the bot did while you were not looking.
 *
 * The README's first line is "a bot that trades your capital while you get on with your life", and
 * until now nothing closed that loop: the app could tell you everything that had ever happened,
 * which on day twenty is a wall of rows, but not the one thing the premise makes you want to know.
 *
 * It renders nothing when nothing happened. A card that says "0 trades since you were last here"
 * is a card people learn to ignore, and the moment it matters is the moment they stop reading it.
 */
import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Eyebrow, Press, SheetCard, Text, colors, radius, size, space } from '@/ui';
import { api } from '@/data/api';
import { useAsync } from '@/data/useAsync';
import { plainAction, plainDetail } from '@/format/activity';

type Entry = { action: string; detail: string; kind: string; at: string };
type CatchUpData = {
  since: string | null;
  isFirstVisit: boolean;
  counts: Record<string, number>;
  entries: Entry[];
};

/** Plain words for the audit kinds, in the order a person cares about them. */
const PHRASE: [string, (n: number) => string][] = [
  ['trade', (n) => `${n} trade${n === 1 ? '' : 's'}`],
  ['block', (n) => `${n} stopped by your limits`],
  ['yield', (n) => `${n} move${n === 1 ? '' : 's'} to yield`],
  ['risk', (n) => `${n} risk check${n === 1 ? '' : 's'}`],
];

export function CatchUp() {
  const router = useRouter();
  const [dismissed, setDismissed] = useState(false);
  const data = useAsync(() => api.get<CatchUpData>('/catchup'), []);

  const acknowledge = useCallback(() => {
    setDismissed(true);
    // Fire and forget: the card is already gone, and failing to record that is not worth an error
    // on the home screen. The worst case is seeing the same summary once more.
    void api.post('/catchup/seen', {}).catch(() => undefined);
  }, []);

  const d = data.data;
  if (dismissed || !d || d.entries.length === 0) return null;

  const summary = PHRASE.filter(([k]) => d.counts[k])
    .map(([k, f]) => f(d.counts[k]!))
    .join(' · ');

  return (
    <SheetCard borderRadius={radius.panel} padding={space.s16}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Eyebrow small>
          {d.isFirstVisit ? 'In the last day' : 'Since you were last here'}
        </Eyebrow>
        <Press
          onPress={acknowledge}
          accessibilityRole="button"
          accessibilityLabel="Mark as read"
          hitHeight={size.hit}
        >
          <Text variant="control" color={colors.ink45}>
            Got it
          </Text>
        </Press>
      </View>

      <Text variant="rowPrimaryLg" style={{ marginTop: space.s8 }}>
        {summary}
      </Text>

      {/* Three, not fifty. The rest is one tap away and the point here is a glance. */}
      {d.entries.slice(0, 3).map((e) => (
        <View key={`${e.at}${e.action}`} style={{ marginTop: space.s10 }}>
          <Text variant="body" color={e.kind === 'block' ? colors.warn : colors.ink}>
            {plainAction(e.action)}
          </Text>
          <Text
            variant="footnote"
            color={colors.ink38}
            style={{ marginTop: space.s2 }}
            numberOfLines={2}
          >
            {plainDetail(e.detail)}
          </Text>
        </View>
      ))}

      {d.entries.length > 3 ? (
        <Press
          onPress={() => router.push('/activity')}
          accessibilityRole="button"
          accessibilityLabel={`See all ${d.entries.length} things that happened`}
          hitHeight={size.hit}
        >
          <Text variant="footnote" color={colors.ink45} style={{ marginTop: space.s12 }}>
            and {d.entries.length - 3} more ›
          </Text>
        </Press>
      ) : null}
    </SheetCard>
  );
}
