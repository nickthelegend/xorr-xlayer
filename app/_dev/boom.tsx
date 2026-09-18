/**
 * A screen that breaks on purpose, so the error boundary can be checked rather than assumed.
 *
 * The boundary's whole claim is that one screen failing leaves the rest of the app usable —
 * the tab bar, the balance, and above all the button that stops the bot. That claim is worth
 * nothing unless something actually throws, and nothing in a healthy app does.
 *
 * It renders normally until asked. A route that threw on load would fail the screen sweep
 * for a thing it does deliberately, and a check that has to be excused is a check nobody
 * trusts.
 */
import React, { useState } from 'react';
import { Text as RNText } from 'react-native';
import { Button, Fill, Screen, Text, colors, space } from '@/ui';

export default function Boom() {
  const [explode, setExplode] = useState(false);

  if (explode) {
    // The shape of a real render failure: reading through something that turned out to be
    // null. Deliberately RN's own Text — the failure has to happen before any of ours runs.
    const nothing = null as unknown as { value: { deep: string } };
    return <RNText>{nothing.value.deep}</RNText>;
  }

  return (
    <Screen>
      <Text variant="screenTitle">Break this screen</Text>
      <Text variant="body" color={colors.ink40} style={{ marginTop: space.s10 }}>
        Throws during render, the way a bad value from an endpoint would. Everything else
        should keep working — check that the tabs still move and that Safety is still
        reachable.
      </Text>
      <Fill />
      <Button label="Throw during render" variant="destructive" onPress={() => setExplode(true)} />
    </Screen>
  );
}
