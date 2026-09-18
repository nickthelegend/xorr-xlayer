/**
 * The network chip where money moves — Deposit, Send and Fund — and the way to every network xorr runs on.
 *
 * It named the network and went nowhere. For a product built to run on whichever chain a hackathon asks for, "which
 * network is this, and which others are there" is exactly the question the chip raises, so it opens Networks.
 */
import React from 'react';
import { useRouter } from 'expo-router';
import { Press, Tag, radius } from '@/ui';
import { networkChip } from '@/chain';

export function NetworkChip() {
  const router = useRouter();
  return (
    <Press
      onPress={() => router.push('/networks')}
      accessibilityRole="button"
      accessibilityLabel={`${networkChip}. See every network`}
      hitHeight={44}
      style={{ alignSelf: 'center' }}
    >
      <Tag label={networkChip} sentence radius={radius.full} />
    </Press>
  );
}
