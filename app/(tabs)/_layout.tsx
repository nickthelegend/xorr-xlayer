/**
 * The tab shell — Home, Swap and Messages (2026-09-15).
 *
 * All drawn by `TabBar`. Home is the one place. Swap opens the swap screen as a sheet from the bottom (`app/_layout.tsx`
 * presents it). Messages raises the drawer of conversations with the agents over whatever you were looking at and over
 * this bar, and closing it puts you back on that screen. The drawer is mounted at the root rather than here, so it can
 * rise over any screen; `/bot` survives as a route for the pushes and links that open it directly.
 *
 * Markets, Assets and the old grid tab are still screens in this group, so every link and push that lands on them still
 * arrives with the bar underneath. Strategies left the group: it is a page with a back arrow now.
 *
 * The bar lives HERE and nowhere else. A screen inside this group must not render its own — the layout already draws one,
 * and two bars stack.
 */
import React, { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { Tabs, usePathname, useRouter } from 'expo-router';
import { TabBar, colors } from '@/ui';
import { useThread } from '@/bot/thread';
import { useChatAgents } from '@/chat/agents';
import { useChatDrawer } from '@/chat/chatDrawer';
import { summaries, unreadTotal } from '@/chat/conversations';
import { useVoice } from '@/chat/voice';
import { useHasHydrated, useStore } from '@/state/store';


export default function TabsLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const show = useChatDrawer((s) => s.show);
  const drawerRaised = useChatDrawer((s) => s.raised);
  const messages = useThread((s) => s.messages);
  const read = useThread((s) => s.read);
  const hydrate = useThread((s) => s.hydrate);
  const readVoice = useVoice((s) => s.read);
  const agents = useChatAgents();
  /*
   * No tab bar until the entry gate has decided (2026-09-25): on a first launch it was drawn over an empty screen for the
   * second before the welcome screen replaced everything. `app/(tabs)/index.tsx` waits on the same two facts.
   */
  const hydrated = useHasHydrated();
  const wallet = useStore((s) => s.wallet);
  const walletChecked = useStore((s) => s.walletChecked);
  const decided = hydrated && (!!wallet || walletChecked);

  // The count on Messages is the thread's, so the thread is read as the shell mounts rather than when the drawer opens.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);
  // Whether the agents can reply is read as the shell mounts too, so a conversation opens knowing what to offer.
  useEffect(() => {
    void readVoice();
  }, [readVoice]);
  const unread = useMemo(
    () => unreadTotal(summaries(messages, agents.map((a) => a.name), read)),
    [messages, agents, read],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Tabs
        tabBar={() => (
          <TabBar
            active={pathname === '/' ? 'home' : null}
            onHome={() => router.navigate('/')}
            onSwap={() => router.push('/swap')}
            onMessages={() => show()}
            unread={unread}
            hidden={drawerRaised || !decided}
          />
        )}
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
      >
        <Tabs.Screen name="index" />
        <Tabs.Screen name="more" />
        <Tabs.Screen name="markets" />
        <Tabs.Screen name="holdings" />
        <Tabs.Screen name="bot" />
      </Tabs>
    </View>
  );
}

/**
 * expo-router renders this instead of the segment when a screen throws.
 *
 * Scoped to the segment rather than the root on purpose: a failing screen inside the tabs
 * keeps the tab bar, so the app stays navigable. A trading app that becomes a dead end because
 * a chart threw is the worst version of this.
 */
export { ScreenError as ErrorBoundary } from '@/errors/ErrorBoundary';
