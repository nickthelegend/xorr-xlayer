/**
 * Approvals — what may pull tokens from this wallet, read from the chain (PLAN.md 3.12).
 *
 * Two spenders, not one. The delegation contract is what the app asks you to approve, so the executor can trade
 * inside your cap. The swap router is what the app never needs approved — the delegation approves it for a single
 * trade and resets it to zero — so an allowance to it was granted somewhere else, and is worth taking back.
 *
 * Every allowance above zero has a button that takes it back: an `approve(spender, 0)` you sign yourself. An allowance
 * nobody could read says so, rather than passing for "None".
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import type { Address } from 'viem';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  EmptyList,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Screen,
  SheetCard,
  Text,
  colors,
  quantity,
  radius,
  size,
  space,
} from '@/ui';
import { shortAddress } from '@/format';
import { useApprovals, type ApprovalSpender, type TokenApproval } from '@/wallet/useApprovals';

export default function Approvals() {
  const goBack = useGoBack();
  const { approvals, loading, loadError, reload, revoke, revoking, error } = useApprovals();
  // An executor older than `spenders` still answers with the delegation's allowances, shown as they always were.
  const spenders: ApprovalSpender[] =
    approvals?.spenders ??
    (approvals
      ? [{ role: 'delegation', name: 'xorr delegation', address: approvals.spender, source: 'chain', tokens: approvals.tokens }]
      : []);

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Approvals</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          What can take tokens from this wallet, read from the chain.
        </Text>
      </View>

      <Fill style={{ marginTop: space.s16 }}>
        {loadError && !approvals ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <ErrorState error={loadError} onRetry={reload} />
          </View>
        ) : loading && !approvals ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <LoadingRows count={5} height={size.rowLg} />
          </View>
        ) : !approvals || approvals.tokens.length === 0 ? (
          <EmptyList list="approvals" />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.s30, gap: space.s10 }}
          >
            {error ? (
              <Text variant="secondary" color={colors.down}>
                {error}
              </Text>
            ) : null}
            {spenders.map((spender) => (
              <SpenderSection key={spender.role} spender={spender} revoke={revoke} revoking={revoking} />
            ))}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}

function SpenderSection({
  spender,
  revoke,
  revoking,
}: {
  spender: ApprovalSpender;
  revoke: (token: TokenApproval, spender: Address) => Promise<unknown>;
  revoking: string | undefined;
}) {
  const tokens = spender.tokens ?? [];
  const unlimited = tokens.filter((t) => t.unlimited).length;
  return (
    <View style={{ gap: space.s10 }}>
      <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
        <Text variant="footnote" color={colors.ink55}>
          {spender.role === 'router' ? 'Spender · the swap router' : 'Spender · the delegation contract'}
        </Text>
        <Text variant="rowPrimary" style={{ marginTop: space.s4 }}>
          {spender.address ? shortAddress(spender.address) : 'Could not be read'}
        </Text>
        {/*
          Counted rather than asserted. "You have three unlimited approvals" is a fact this screen can check;
          "your approvals are safe" is not.
        */}
        <Text
          variant="secondarySm"
          color={spender.tokens === null ? colors.ink40 : unlimited > 0 ? colors.warn : colors.ink40}
          style={{ marginTop: space.s8 }}
        >
          {spender.tokens === null
            ? 'Its allowances could not be read just now.'
            : unlimited === 0
              ? 'No unlimited approvals.'
              : unlimited === 1
                ? 'One token is approved without a limit.'
                : `${unlimited} tokens are approved without a limit.`}
        </Text>
      </SheetCard>
      {tokens.map((t) => (
        <ApprovalRow key={`${spender.role}:${t.address}`} token={t} spender={spender.address} revoke={revoke} revoking={revoking} />
      ))}
    </View>
  );
}

function ApprovalRow({
  token,
  spender,
  revoke,
  revoking,
}: {
  token: TokenApproval;
  spender: Address | null;
  revoke: (token: TokenApproval, spender: Address) => Promise<unknown>;
  revoking: string | undefined;
}) {
  const tone = token.unread || token.none ? colors.ink40 : token.unlimited ? colors.warn : colors.up;
  const state = token.unread ? 'Could not be read' : token.none ? 'None' : token.unlimited ? 'Unlimited' : 'Limited';
  const busy = spender !== null && revoking === `${spender}:${token.symbol}`;
  const canTakeBack = !token.none && !token.unread && spender !== null;
  /*
   * The amount in the token's own units, only when the executor sent one. An executor older than `display` sends
   * nothing (see `TokenApproval`), and printing it anyway put "undefined USDC" on screen. The raw value below still
   * says exactly what is allowed, so an absent amount is simply not repeated.
   */
  const amount =
    typeof token.display === 'string' && token.display.trim() !== '' && Number.isFinite(Number(token.display))
      ? Number(token.display)
      : undefined;
  return (
    <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Text variant="rowPrimary">{token.symbol}</Text>
        <Text variant="control" color={tone}>
          {state}
        </Text>
      </View>
      <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s4 }}>
        {shortAddress(token.address)}
      </Text>
      {token.none || token.unlimited || token.unread || amount === undefined ? null : (
        <Text variant="secondarySm" color={colors.ink65} style={{ marginTop: space.s8 }}>
          {`${quantity(amount, amount >= 1 ? 2 : 4)} ${token.symbol}`}
        </Text>
      )}
      {/*
        The raw value, for the reader who wants to check it against an explorer. Wrapped rather than truncated: a
        uint256 with an ellipsis in the middle cannot be compared to anything.
      */}
      {token.none || token.unread ? null : (
        <Text variant="footnoteSm" color={colors.ink55} style={{ marginTop: space.s6 }}>
          {token.allowance}
        </Text>
      )}
      {canTakeBack ? (
        <Button
          label={busy ? 'Taking it back…' : 'Take it back'}
          variant="ghost"
          loading={busy}
          onPress={() => void revoke(token, spender)}
          style={{ marginTop: space.s10 }}
        />
      ) : null}
    </SheetCard>
  );
}
