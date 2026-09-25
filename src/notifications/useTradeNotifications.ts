/**
 * A banner on the phone when an agent trades, while the app is open (2026-09-25).
 *
 * The executor's push is the real path (`server/src/notifications/push.ts`), and it needs a device token. Where this
 * build could not get one — no EAS project, or a simulator — the push had nowhere to go, and a fill landed in
 * silence. So while the app is in the foreground and signed in, it reads its own trail every few seconds, and a new
 * fill raises a local notification: the same title-and-sentence a push carries, opening the same row on tap
 * (`useNotificationRoute`). Where push registration worked, this stays out of the way, so nothing arrives twice.
 */
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { api } from '@/data/api';
import type { ActivityEvent } from '@/data/types';
import { useStore } from '@/state/store';
import type { RegistrationResult } from './index';
import { bannerFor, freshTrades } from './tradeNotices';

/** How often the trail is read while the app is open. A fill is a transaction, so a few seconds late is on time. */
const POLL_MS = 8_000;

export function useTradeNotifications(push: RegistrationResult | undefined): void {
  const wallet = useStore((s) => s.wallet);
  // The newest row already seen, per wallet. Undefined until the first read, which only sets it.
  const seen = useRef<number | undefined>(undefined);

  useEffect(() => {
    const address = wallet?.address;
    // A registered device hears from the executor itself; before registration has answered, wait for it.
    if (!address || !push || push.ok) return;
    seen.current = undefined;
    let busy = false;

    const read = async () => {
      if (busy || AppState.currentState !== 'active') return;
      busy = true;
      try {
        const events = await api.get<ActivityEvent[]>('/activity');
        const { banners, newest } = freshTrades(Array.isArray(events) ? events : [], seen.current);
        seen.current = newest;
        for (const e of banners) {
          // `trigger: null` is now: the handler in `./index` shows it as a banner even with the app in front.
          await Notifications.scheduleNotificationAsync({ content: bannerFor(e), trigger: null });
        }
      } catch {
        // A read that fails is tried again on the next beat; the trail itself is never touched from here.
      } finally {
        busy = false;
      }
    };

    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => clearInterval(timer);
  }, [wallet?.address, push]);
}
