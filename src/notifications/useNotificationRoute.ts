/**
 * A tapped notification opens the thing it is about.
 *
 * Nothing listened for a tap. `push.ts` has always sent a `route` in the payload and `routeFor` has
 * always known which screen a kind belongs to, and neither was ever connected to the router — so
 * every notification, whatever it said, opened the app wherever it had last been left. "A trade was
 * stopped" put you on the home screen, and finding out which trade was your problem.
 *
 * Two arrivals have to be handled and they are genuinely different:
 *
 *   cold — the app was not running. The tap IS the launch, and the response is waiting to be read
 *          when the tree mounts. `useLastNotificationResponse` is how expo-notifications hands that
 *          over; a listener alone would miss it, because the event fired before any listener existed.
 *   warm — the app was already running. A listener fires.
 *
 * Both go through `deepRouteFor`, so a tap lands on the audit row or the asset where the push
 * carried enough to name one, and on the kind's own screen where it did not.
 */
import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { deepRouteFor, type PushPayload } from './routes';

/** The payload the executor attached, as expo-notifications hands it back. */
function payloadOf(response: Notifications.NotificationResponse | null | undefined): PushPayload | undefined {
  const data = response?.notification?.request?.content?.data;
  return data && typeof data === 'object' ? (data as PushPayload) : undefined;
}

export function useNotificationRoute(): void {
  const router = useRouter();

  /*
   * The last response this hook acted on.
   *
   * `useLastNotificationResponse` keeps returning the SAME response for the life of the process —
   * it is the launch fact, not an event — so without this the effect would re-navigate on every
   * render that touched it, and a user who swiped back would be thrown forward again.
   */
  const handled = useRef<string | undefined>(undefined);
  const cold = Notifications.useLastNotificationResponse();

  useEffect(() => {
    const id = cold?.notification?.request?.identifier;
    if (!cold || !id || handled.current === id) return;
    handled.current = id;
    router.push(deepRouteFor(payloadOf(cold)) as never);
  }, [cold, router]);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const id = response.notification.request.identifier;
      // The warm listener and the cold value can both see the same tap on some platforms. One
      // navigation per notification, whichever noticed it first.
      if (handled.current === id) return;
      handled.current = id;
      router.push(deepRouteFor(payloadOf(response)) as never);
    });
    return () => sub.remove();
  }, [router]);
}
