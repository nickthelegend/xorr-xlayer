/**
 * Nothing to route on the web: there are no push notifications to tap (PLAN.md 12.19).
 *
 * The web build never imports `expo-notifications` — it registers a push-token listener the moment
 * it loads, which the web cannot honour — so this is the same no-op shape `index.web.ts` takes, for
 * the same reason. A link pasted into a browser is handled by expo-router's own linking, which does
 * not go through here.
 */
export function useNotificationRoute(): void {
  // Deliberately empty.
}
