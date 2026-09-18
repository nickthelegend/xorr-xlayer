/**
 * Push notifications on the web: there are none (PLAN.md 12.19).
 *
 * `expo-notifications` registers a push-token listener the moment it is imported, and the web cannot honour it: every
 * load of the hosted app logged "Listening to push token changes is not yet fully supported on web". Push is a phone
 * feature here, so the web build never imports the module, and asking to register says why nothing will arrive.
 * Alerts still fire on the executor either way.
 */
export { MUTABLE, routeFor, type AlertKind } from './routes';

export type RegistrationResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'denied' | 'unsupported' | 'unconfigured' | 'error'; detail: string };

export async function register(): Promise<RegistrationResult> {
  return { ok: false, reason: 'unsupported', detail: 'Push alerts arrive on the phone app.' };
}
