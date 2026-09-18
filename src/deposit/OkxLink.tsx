/**
 * "Open OKX" — the way in for someone without USDC or USDT0 on X Layer yet (PLAN.md P4.7, D8, D16).
 *
 * The purchase happens on OKX, and the copy says so: buy there, then withdraw to this address choosing the X Layer
 * network. No card form in the app. Only where money is real — on a test network OKX has nothing to send.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { Button, Text, colors, space } from '@/ui';
import { errorText } from '@/data/apiError';
import { openOkx } from './okx';

export function OkxLink() {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();

  async function open() {
    if (opening) return;
    setOpening(true);
    setError(undefined);
    try {
      await openOkx();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setOpening(false);
    }
  }

  return (
    <View style={{ gap: space.s8 }}>
      <Button label="Open OKX" variant="secondary" loading={opening} onPress={open} />
      <Text variant="footnote" color={colors.ink55}>
        Buy USDC or USDT0 on OKX, then withdraw it to this address and choose the X Layer network. If OKX has no USDC on
        X Layer, withdraw USDT0 and convert it here.
      </Text>
      {error ? (
        <Text variant="footnote" color={colors.down}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
