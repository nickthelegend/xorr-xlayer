/**
 * `/bot` — raises the Messages drawer, and steps aside.
 *
 * Messages is a drawer that slides up over the screen you are on (`src/chat/ChatSheet.tsx`), never a page with the tab
 * bar under it. The route stays because pushes and links still arrive at it: `routeFor('proposal-awaiting')` returns
 * `/bot`, and the morning briefing's button pushes it. So it opens the drawer — on the list, where the agent asking for
 * something is marked, or straight into one agent's conversation when the link names it (`/bot?agent=yield-keeper`) —
 * and gets out of the way: back to the screen that pushed it, or home for a push or a typed address with nothing behind
 * it.
 */
import React, { useEffect } from 'react';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { Screen } from '@/ui';
import { useChatAgents } from '@/chat/agents';
import { useChatDrawer } from '@/chat/chatDrawer';

export default function BotChat() {
  const router = useRouter();
  const { agent } = useLocalSearchParams<{ agent?: string }>();
  const show = useChatDrawer((s) => s.show);
  const cameFromAScreen = router.canGoBack();
  const agents = useChatAgents();
  // By persona id or by name; a link naming no agent this app has opens the list rather than a conversation with no one.
  const named = agents.find((a) => a.id === agent || a.name === agent)?.name ?? null;

  useEffect(() => {
    show(named);
    if (cameFromAScreen) router.back();
  }, [show, named, router, cameFromAScreen]);

  // The app's ground for the frame it takes to step back, rather than no shell at all.
  return cameFromAScreen ? <Screen /> : <Redirect href="/" />;
}
