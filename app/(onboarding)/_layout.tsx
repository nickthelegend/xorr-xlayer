import React from 'react';
import { Stack } from 'expo-router';
import { colors } from '@/ui';

export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}
    />
  );
}

/**
 * expo-router renders this instead of the segment when a screen throws.
 *
 * Scoped to the segment: a failure inside onboarding must not take out the whole app, and
 * the user needs a way back to a screen that works.
 */
export { ScreenError as ErrorBoundary } from '@/errors/ErrorBoundary';
