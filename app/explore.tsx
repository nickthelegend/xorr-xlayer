/**
 * Explore — one door to everything the app can show about itself, grouped by the question it answers.
 *
 * A screen nobody can reach is worse than no screen, and thirty-odd surfaces cannot each earn a row in Settings. Not a
 * search field: thirty items is a list you scan. Distilled 2026-09-14 (PLAN.md O3): a title and a few words per row,
 * and no network or venue names — those live on How it works.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import { Eyebrow, Fill, HeaderBar, Press, Screen, Text, colors, divider, size, space } from '@/ui';
import { Icon } from '@/design/Icon';

type Item = { route: string; title: string; detail: string };
type Group = { title: string; items: Item[] };

/** Each `detail` says what the screen shows, in a few words, rather than restating its title. */
const GROUPS: Group[] = [
  {
    title: 'Money',
    items: [
      { route: '/deposit', title: 'Deposit', detail: 'Add funds' },
      { route: '/swap', title: 'Swap', detail: 'One token for another' },
      { route: '/withdraw-everything', title: 'Withdraw everything', detail: 'Sell and send it all' },
      { route: '/history', title: 'History', detail: 'Every settled trade' },
      { route: '/pnl', title: 'Realised', detail: 'Profit on closed positions' },
      { route: '/limits', title: 'Today’s limit', detail: 'Spent and left' },
      { route: '/allocation', title: 'Allocation', detail: 'Where the money sits' },
      { route: '/balance', title: 'Balance', detail: 'Cash, held and earning' },
      { route: '/rates', title: 'Rate', detail: 'What idle cash earns' },
      { route: '/disposals', title: 'Disposals', detail: 'Cost basis per sale' },
      { route: '/export', title: 'Export', detail: 'Files for an accountant' },
      { route: '/sell-everything', title: 'What would sell', detail: 'A preview first' },
    ],
  },
  {
    title: 'Markets',
    items: [
      /*
        The four that worked and had no way in (docs/qa/SCREENS.md, "Orphaned routes"), titled as each screen titles
        itself. `/watchlist` calls itself "Markets" too, so its detail is what tells the two apart.
      */
      { route: '/markets', title: 'Markets', detail: 'Every class, priced' },
      { route: '/search', title: 'Search', detail: 'Find a market' },
      { route: '/watchlist', title: 'Markets', detail: 'Three short lists' },
      { route: '/movers', title: 'Movers', detail: 'Biggest moves today' },
      { route: '/stocks', title: 'Stocks', detail: 'Priced by a real buy' },
      { route: '/xstocks', title: 'xStocks', detail: 'Tokenized shares' },
      { route: '/earnings', title: 'Earnings', detail: 'Filing dates' },
      { route: '/funding', title: 'Funding', detail: 'Perpetual funding rates' },
      { route: '/compare', title: 'Compare', detail: 'Two instruments, one range' },
      { route: '/tokens', title: 'Tokens', detail: 'What can be traded' },
      { route: '/coverage', title: 'Coverage', detail: 'Priced against tradable' },
    ],
  },
  {
    title: 'Activity',
    items: [
      // The one place a strategy can be paused, and it had no row: only agent pages and strategy alerts led there.
      { route: '/strategies', title: 'Strategies', detail: 'What runs, and pausing it' },
      { route: '/runs', title: 'Runs', detail: 'Fills and refusals' },
      { route: '/proposals', title: 'Proposals', detail: 'Asked and answered' },
      { route: '/catchup', title: 'Since you looked', detail: 'While you were away' },
      { route: '/schedule', title: 'What runs next', detail: 'Upcoming runs' },
      { route: '/backtest', title: 'Backtest', detail: 'A weekly buy, on real prices' },
      { route: '/roster-compare', title: 'Compare agents', detail: 'Side by side' },
      { route: '/risk', title: 'Risk limits', detail: 'Per agent' },
      { route: '/voice', title: 'Voice', detail: 'How the bot talks' },
      { route: '/bot/roster', title: 'Agents', detail: 'Hire or let go' },
      { route: '/bot/leaderboard', title: 'Leaderboard', detail: 'Agents, ranked' },
      { route: '/briefing', title: 'Briefing', detail: 'Headlines, and what agents did' },
    ],
  },
  {
    title: 'Proof',
    items: [
      { route: '/verify', title: 'Verification', detail: 'Live checks, with evidence' },
      { route: '/judge', title: 'Check it yourself', detail: 'Every claim, run again' },
      { route: '/sponsors', title: 'How it works', detail: 'The tech behind xorr' },
      { route: '/delegation', title: 'Permission', detail: 'Key, venues, cap, expiry' },
      { route: '/approvals', title: 'Approvals', detail: 'What can be pulled' },
      { route: '/policy', title: 'Wallet policy', detail: 'What your wallet refuses' },
      { route: '/venues', title: 'Venues', detail: 'Where fills may go' },
      { route: '/audit/chain', title: 'Audit trail', detail: 'Whether the record holds' },
      { route: '/sources', title: 'Sources', detail: 'Where each number comes from' },
    ],
  },
  {
    title: 'System',
    items: [
      { route: '/system', title: 'System', detail: 'Services and their health' },
      { route: '/network', title: 'Network', detail: 'Where this app runs' },
      { route: '/networks', title: 'Networks', detail: 'Every network xorr runs on' },
      { route: '/metrics', title: 'Metrics', detail: 'What has been done' },
    ],
  },
  {
    title: 'Account',
    items: [
      { route: '/profile', title: 'This wallet', detail: 'Address and activity' },
      { route: '/business', title: 'Business', detail: 'A treasury the bot trades' },
      { route: '/notifications', title: 'Notifications', detail: 'What interrupts you' },
    ],
  },
];

export default function Explore() {
  const goBack = useGoBack();
  const router = useRouter();

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Explore</Text>} />
      </View>

      <Fill style={{ marginTop: space.s8 }}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.s30 }}
        >
          {GROUPS.map((g) => (
            <View key={g.title} style={{ marginTop: space.s22 }}>
              <Eyebrow>{g.title}</Eyebrow>
              {g.items.map((item) => (
                <Press
                  key={item.route}
                  onPress={() => router.push(item.route as never)}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.title}. ${item.detail}`}
                  style={[
                    {
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.s12,
                      minHeight: size.rowLg,
                      paddingVertical: space.s10,
                    },
                    divider,
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text variant="rowPrimary">{item.title}</Text>
                    <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s2 }}>
                      {item.detail}
                    </Text>
                  </View>
                  <Icon name="chevron" size={14} color={colors.ink30} />
                </Press>
              ))}
            </View>
          ))}
        </ScrollView>
      </Fill>
    </Screen>
  );
}
