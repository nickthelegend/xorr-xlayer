/**
 * Push notifications — PLAN.md 12.19, closing [G30].
 *
 * screens.md screen 18 lists five alerts and a rule that matters more than any of them:
 * "Circuit breakers stay on even when notifications are muted. They stop trading, not just your
 * phone." So the toggles here govern INTERRUPTION ONLY. The breakers that stop trading live in the
 * server's rule engine and are deliberately unreachable from this file.
 */
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from '../data/api';

export { MUTABLE, routeFor, type AlertKind } from './routes';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    // copy.md's restraint applies to sound too: a trading app that pings all day gets muted.
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
});

export type RegistrationResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'denied' | 'unsupported' | 'unconfigured' | 'error'; detail: string };

/**
 * Ask for permission and register the device with the executor.
 *
 * A simulator cannot produce a push token. The caller is told that plainly rather than handed a
 * fake one — a fake token would make the feature look wired when nothing would ever arrive.
 */
export async function register(): Promise<RegistrationResult> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('xorr', {
        name: 'xorr',
        importance: Notifications.AndroidImportance.DEFAULT,
        sound: null,
        vibrationPattern: [0, 120],
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') {
      return { ok: false, reason: 'denied', detail: 'Notification permission was not granted.' };
    }

    /*
     * Expo cannot mint a token without knowing which project it is for.
     *
     * `getExpoPushTokenAsync()` infers the id from the manifest in a managed build and cannot in a
     * prebuilt one, so every launch logged `[push] not registered (error): No "projectId" found` —
     * an SDK sentence, filed as an error, for a build that simply has no EAS project. It is
     * configuration, not a fault, and it now says so under its own reason. Pass the id explicitly
     * where one exists, so a build that HAS an EAS project works without further change.
     */
    const projectId =
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas
        ?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) {
      return {
        ok: false,
        reason: 'unconfigured',
        detail:
          'No EAS project id in this build, so Expo cannot issue a push token. Alerts still fire on the executor; this device just cannot be notified.',
      };
    }
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await api.post('/devices/register', { token, platform: Platform.OS });
    return { ok: true, token };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (/simulator|emulator|must be a physical/i.test(detail)) {
      return { ok: false, reason: 'unsupported', detail: 'Push needs a physical device.' };
    }
    return { ok: false, reason: 'error', detail };
  }
}
