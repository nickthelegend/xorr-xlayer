/**
 * The fidelity harness — PLAN.md 2.8 / §3.9.
 *
 * Renders any route at a LOCKED 402 x 874 — the exact canvas the handoff was authored on — with a
 * token overlay, so fidelity is diffed rather than eyeballed. This is the screen PLAN.md 13.1 uses
 * for the screen-by-screen pass and the one store screenshots come from.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Button,
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  Eyebrow,
  Fill,
  Press,
  Screen,
  Text,
  colors,
  divider,
  duration,
  radius,
  size,
  space,
} from '@/ui';

/** Every route worth checking against the reference, in the handoff's own numbering. */
const SCREENS: { n: string; label: string; route: string }[] = [
  { n: '1', label: 'Splash', route: '/(onboarding)' },
  { n: '2', label: 'Wallet home', route: '/(tabs)' },
  { n: '3', label: 'Agent intro', route: '/bot/momentum-scout/intro' },
  { n: '4', label: 'Trade settings', route: '/bot/momentum-scout/settings' },
  { n: '5', label: 'Watchlist', route: '/watchlist' },
  { n: '6', label: 'Auto Close', route: '/auto-close/current' },
  { n: '7', label: 'Goals & risk', route: '/goals' },
  { n: '8→', label: 'Wallet setup', route: '/wallet' },
  { n: '9→', label: 'Fund', route: '/fund' },
  { n: '—', label: 'Grant delegation', route: '/delegate' },
  { n: '10', label: 'Portfolio proposal', route: '/proposal' },
  { n: '11', label: 'Agent roster', route: '/bot/roster' },
  { n: '12', label: 'Bot chat', route: '/bot' },
  { n: '13', label: 'Asset detail', route: '/asset/SOL' },
  { n: '14', label: 'Order ticket', route: '/order/SOL' },
  { n: '15', label: 'Activity', route: '/activity' },
  { n: '16', label: 'Leaderboard', route: '/bot/leaderboard' },
  { n: '17', label: 'Backtest', route: '/bot/momentum-scout/backtest' },
  { n: '18', label: 'Alerts', route: '/alerts' },
  { n: '19', label: 'Swap', route: '/swap' },
  { n: '20', label: 'Kill switch', route: '/safety' },
  { n: '21', label: 'Pro chart', route: '/chart/BTC' },
  { n: '22', label: 'Position', route: '/position/current' },
  { n: '23', label: 'Briefing', route: '/briefing' },
  { n: '24', label: 'Markets', route: '/markets' },
  { n: '25', label: 'Perp contract', route: '/perp/XAUT' },
  { n: '—', label: 'Strategies (new)', route: '/strategies' },
  { n: '—', label: 'Assets (new)', route: '/holdings' },
  { n: '—', label: 'DCA setup (new)', route: '/strategy/dca' },
];

export default function Fidelity() {
  const router = useRouter();
  const [overlay, setOverlay] = useState(true);

  return (
    <Screen>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <Text variant="screenTitle">Fidelity</Text>
        <Button
          label={overlay ? 'Hide grid' : 'Show grid'}
          variant="ghost"
          height={size.mark}
          onPress={() => setOverlay((o) => !o)}
        />
      </View>
      <Text variant="secondary" style={{ marginTop: space.s10 }}>
        Design canvas {DESIGN_WIDTH} × {DESIGN_HEIGHT}. Open a screen and compare it against
        ui/mobile-ui/reference/.
      </Text>

      <Fill style={{ marginTop: space.s16 }}>
        <ScrollView showsVerticalScrollIndicator={false}>
          {overlay ? <TokenOverlay /> : null}

          <Eyebrow small style={{ marginTop: space.s20, marginBottom: space.s8 }}>
            Screens
          </Eyebrow>
          {SCREENS.map((s) => (
            <Press
              key={s.route + s.label}
              accessibilityRole="button"
              accessibilityLabel={`Open ${s.label}`}
              onPress={() => router.push(s.route as never)}
              style={[
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.s12,
                  height: size.rowSm,
                },
                divider,
              ]}
            >
              <Text variant="footnote" color={colors.ink32} style={{ width: 26 }}>
                {s.n}
              </Text>
              <Text variant="rowPrimary" style={{ flex: 1 }}>
                {s.label}
              </Text>
              <Text variant="footnote" color={colors.ink28}>
                {s.route}
              </Text>
            </Press>
          ))}
          <View style={{ height: space.s30 }} />
        </ScrollView>
      </Fill>
    </Screen>
  );
}

/** The values design.md fixes, on screen, so a drift is visible rather than argued about. */
function TokenOverlay() {
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: radius.panel,
        padding: space.s16,
        gap: space.s12,
      }}
    >
      <Eyebrow small>Tokens in play</Eyebrow>
      <TokenRow label="Gutter" value={`${space.gutter}px`} />
      <TokenRow label="Row heights" value={`${size.rowSm} / ${size.row} / ${size.rowLg}`} />
      <TokenRow label="Hairline" value={colors.hairline} />
      <TokenRow label="Durations" value={Object.values(duration).join(' / ')} />
      <View style={{ flexDirection: 'row', gap: space.s8, marginTop: space.s4 }}>
        {(
          [
            ['bg', colors.bg],
            ['surface', colors.surface],
            ['control', colors.control],
            ['up', colors.up],
            ['down', colors.down],
            ['warn', colors.warn],
          ] as const
        ).map(([name, color]) => (
          <View key={name} style={{ alignItems: 'center', gap: space.s4 }}>
            <View
              style={{
                width: 30,
                height: 30,
                borderRadius: radius.glyph,
                backgroundColor: color,
                borderWidth: 1,
                borderColor: colors.cardBorder,
              }}
            />
            <Text variant="footnoteSm" color={colors.ink28}>
              {name}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function TokenRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text variant="secondary">{label}</Text>
      <Text variant="secondary" color={colors.ink}>
        {value}
      </Text>
    </View>
  );
}
