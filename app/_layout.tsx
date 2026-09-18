/**
 * Root layout. animations.md: "Screen transitions — use the platform default push/present.
 * Don't author custom ones."
 */
import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppPrivyProvider } from '@/auth/PrivyProvider';
import { PhoneFrame, colors } from '@/ui';
import { useRegisterDevice } from '@/notifications/useRegisterDevice';
import { useNotificationRoute } from '@/notifications/useNotificationRoute';
import { useHydrateWallet } from '@/wallet/useHydrateWallet';
import { useHydrateDelegation } from '@/wallet/useHydrateDelegation';
import { ReachabilityProvider } from '@/net/Reachability';
import { ChatSheet } from '@/chat/ChatSheet';
import { useChatDrawer } from '@/chat/chatDrawer';

/**
 * Hold the splash until the typefaces are ready.
 *
 * At module scope on purpose: it has to run before the first render, and it used to sit
 * between the imports, which is both a lint error and a real hazard — a bundler is free to
 * hoist imports above it, and then the splash hides before the call lands.
 */
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

/**
 * Files this device's push token against the signed-in wallet.
 *
 * A component rather than a hook call in RootLayout so it sits INSIDE the Privy provider — the
 * wallet it keys on does not exist above it. Renders nothing.
 */
function DeviceRegistration() {
  useRegisterDevice();
  return null;
}

/**
 * A tapped notification opens the thing it is about — PLAN.md 10.10.
 *
 * `push.ts` has always attached a route to every message and nothing ever read it, so a tap opened
 * the app wherever it had last been left: "A trade was stopped" landed on the home screen, and
 * finding out which trade was the user's problem. `useNotificationRoute` handles both the cold tap
 * that launched the app and the warm one that arrived while it was open.
 *
 * At the root and inside the Stack's provider, because it navigates: a hook that pushes a route
 * needs a router, and the router does not exist above `<Stack>`.
 */
function NotificationRouting() {
  useNotificationRoute();
  return null;
}

/**
 * Loads the signed-in user's wallet from the executor, wherever they entered the app.
 *
 * Mounted at the root because the alternative — populating it only in the onboarding flow, which
 * is what used to happen — meant the client forgot the user's wallet the moment they arrived any
 * other way. `/` redirects to onboarding on a missing wallet, so that was not a display bug: it
 * sent people with accounts, permissions and positions back through sign-up.
 *
 * Inside the Privy provider, for the same reason DeviceRegistration is: it keys on auth state.
 */
function WalletHydration() {
  useHydrateWallet();
  // The permission governing the user's money, read from the chain rather than remembered from
  // whichever screen last wrote it. See useHydrateDelegation.
  useHydrateDelegation();
  return null;
}

/**
 * The Messages drawer, over every screen.
 *
 * Mounted once, after the navigator and inside the frame, so it slides up over whatever screen is open —
 * the tab bar included — and is clipped to the phone column on a wide browser like everything else. It is
 * opened through `useChatDrawer`: by the tab bar's Messages button, and by the `/bot` route that pushes and
 * the briefing link to.
 */
function ChatDrawer() {
  const open = useChatDrawer((s) => s.open);
  const hide = useChatDrawer((s) => s.hide);
  return <ChatSheet open={open} onClose={hide} />;
}

export default function RootLayout() {
  /*
   * Hold the splash until the typefaces are in.
   *
   * Without this the app paints one frame in the platform's fallback face and then reflows when
   * Inter arrives — every heading jumps, which on a screen full of prices reads as the numbers
   * moving. The splash is already on screen; keeping it there for the extra beat costs nothing and
   * hides the swap entirely.
   */
  const [fontsLoaded] = useFonts({
    'Inter-Regular': require('../assets/fonts/Inter-Regular.ttf'),
    'Inter-Medium': require('../assets/fonts/Inter-Medium.ttf'),
    'Inter-SemiBold': require('../assets/fonts/Inter-SemiBold.ttf'),
    'Inter-Bold': require('../assets/fonts/Inter-Bold.ttf'),
    'Inter-ExtraBold': require('../assets/fonts/Inter-ExtraBold.ttf'),
    // The display face, for the wordmark only — as the design reference uses it.
    'Baloo2-Bold': require('../assets/fonts/Baloo2-Bold.ttf'),
    'Baloo2-ExtraBold': require('../assets/fonts/Baloo2-ExtraBold.ttf'),
  });

  useEffect(() => {
    if (fontsLoaded) void SplashScreen.hideAsync().catch(() => undefined);
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <AppPrivyProvider>
      <SafeAreaProvider>
        <ReachabilityProvider>
        <WalletHydration />
        <DeviceRegistration />
        {/* The app is true-black by design; the OS theme never gets to change it. */}
        <StatusBar style="light" />
        {/*
          Inside the frame, so the tab bar and the chat sheet are constrained with the content —
          both position themselves against their parent, and a per-screen fix would have left them
          spanning the whole window.
        */}
        <PhoneFrame>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
            animation: 'default',
          }}
        >
          <Stack.Screen name="(onboarding)" />
          <Stack.Screen name="(tabs)" />
          {/*
            A coin opens as a sheet over the screen you tapped it on — the reference video's move.
            Still the platform's own present, not a custom transition.
          */}
          <Stack.Screen name="asset/[symbol]" options={{ presentation: 'modal' }} />
          {/* The balance opens the portfolio, and the wallet header opens the profile — both as sheets. */}
          <Stack.Screen name="portfolio" options={{ presentation: 'modal' }} />
          <Stack.Screen name="profile" options={{ presentation: 'modal' }} />
          <Stack.Screen name="order/[symbol]" options={{ presentation: 'modal' }} />
          <Stack.Screen name="xstock/[symbol]" options={{ presentation: 'modal' }} />
          <Stack.Screen name="auto-close/[id]" options={{ presentation: 'modal' }} />
          {/* The reasons behind a trade rise over the trail row they belong to, not away from it. */}
          <Stack.Screen name="explain/[seq]" options={{ presentation: 'modal' }} />
          {/* The risk setting opens over the panel describing the behaviour it governs. */}
          <Stack.Screen name="agent/risk" options={{ presentation: 'modal' }} />
          {/* The basket, and how far it has drifted from what was asked for. */}
          <Stack.Screen name="agent/basket" options={{ presentation: 'modal' }} />
          <Stack.Screen name="bot/[id]/intro" options={{ presentation: 'modal' }} />
          <Stack.Screen name="bot/[id]/settings" options={{ presentation: 'modal' }} />
          <Stack.Screen name="strategy/dca" options={{ presentation: 'modal' }} />
          <Stack.Screen name="agent/strategies" options={{ presentation: 'modal' }} />
          {/* Swap rises from the bottom, from the tab bar's centre: a sheet over the screen it was asked from. */}
          <Stack.Screen name="swap" options={{ presentation: 'modal' }} />
        </Stack>
        {/* After the Stack, so `useRouter` resolves against a mounted navigator. */}
        <NotificationRouting />
        <ChatDrawer />
        </PhoneFrame>
        </ReachabilityProvider>
      </SafeAreaProvider>
      </AppPrivyProvider>
    </GestureHandlerRootView>
  );
}

/**
 * expo-router renders this instead of the segment when a screen throws.
 *
 * Scoped to the segment rather than the root on purpose: a failing screen inside the tabs keeps
 * the tab bar, so Safety — and the button that stops the bot — is still one tap away. A trading
 * app whose kill switch becomes unreachable because a chart threw is the worst version of this.
 */
export { ScreenError as ErrorBoundary } from '@/errors/ErrorBoundary';
