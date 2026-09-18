/**
 * What a strategy did over the last 90 days of real prices: its return and trades, a skeleton while the replay runs or
 * today's price is read, or — for a strategy whose result is not a price path — what it does instead.
 */
import React from 'react';
import { Placeholder, Text, colors, space } from '@/ui';
import { percent } from '@/format';
import type { Marks, Replay, StrategyTemplate } from './agentStrategies';

const LINE_W = 160;
const LINE_H = 12;

export function ReplayLine({
  template,
  replay,
  marks,
}: {
  template: StrategyTemplate;
  replay: Replay | undefined;
  marks: Marks;
}) {
  if (template.needs && !marks[template.needs]) {
    return <Placeholder width={LINE_W} height={LINE_H} style={{ marginTop: space.s8 }} />;
  }
  if (!template.replay) {
    return (
      <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s6 }}>
        {template.note ?? ''}
      </Text>
    );
  }
  if (!replay) return <Placeholder width={LINE_W} height={LINE_H} style={{ marginTop: space.s8 }} />;
  if ('failed' in replay) {
    return (
      <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s6 }}>
        Couldn’t replay it right now
      </Text>
    );
  }
  const trades = `${replay.trades} ${replay.trades === 1 ? 'trade' : 'trades'}`;
  return (
    <Text
      variant="secondarySm"
      color={replay.ret > 0 ? colors.up : replay.ret < 0 ? colors.down : colors.ink55}
      style={{ marginTop: space.s6 }}
    >
      {`${percent(replay.ret, { digits: 1, explicitSign: true })} in 90 days · ${trades}`}
    </Text>
  );
}
