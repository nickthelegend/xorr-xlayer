/**
 * BackingDrawer.tsx — what actually backs a position.
 *
 * Opened from a position, and built on one rule: every line is a recorded value or an admission
 * that there is none. A field we could not read says "No record" in words rather than showing a
 * dash, because a dash in a column of numbers reads as zero — and "nobody can freeze this token"
 * and "we could not find out who can" are opposite facts about a security.
 *
 * The attestation always carries its age. "1.0011x backed" with no time attached reads as "right
 * now"; where the observation is old, the drawer says how old and marks it stale rather than
 * letting it pass for current.
 */
import React from 'react';
import { View, ScrollView } from 'react-native';
import { SheetCard } from './SheetCard';
import { Text } from './Text';
import { Tag } from './Tag';
import { colors, space } from './tokens';
import {
  attestationAge,
  NO_RECORD,
  type BackingDetail,
} from '../data/backingDetail';
import { ReservesHistoryChart } from './charts/ReservesHistoryChart';
import type { ReservesHistory } from '../data/reservesHistory';
import { yieldLine, type YieldWindow } from '../data/dividendYield';

/** A label and either a value or, honestly, the absence of one. */
function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <View style={{ gap: space.s2 }}>
      <Text variant="eyebrowSm" color={colors.ink30}>
        {label}
      </Text>
      <Text
        variant="footnoteSm"
        color={value === null ? colors.ink30 : colors.ink}
        numberOfLines={2}
      >
        {value ?? NO_RECORD}
      </Text>
    </View>
  );
}

function short(address: string | null): string | null {
  if (!address) return null;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function BackingDrawer({
  detail,
  history,
  income,
}: {
  detail?: BackingDetail | null;
  /** `undefined` while loading, `null` where it could not be read. */
  history?: ReservesHistory | null;
  /** What the token has paid, derived from its multiplier. */
  income?: YieldWindow;
}) {
  if (detail === undefined) {
    return (
      <SheetCard>
        <Text variant="footnoteSm" color={colors.ink50}>
          Reading what backs this position…
        </Text>
      </SheetCard>
    );
  }
  if (detail === null) {
    return (
      <SheetCard>
        <Text variant="footnoteSm" color={colors.ink50}>
          Backing details could not be loaded for this position.
        </Text>
      </SheetCard>
    );
  }

  const { reserves, issuer, multiplier } = detail;

  return (
    <ScrollView>
      <SheetCard>
        <View style={{ gap: space.s16 }}>
          <View style={{ gap: space.s4 }}>
            <Text variant="sheetTitle" color={colors.ink}>
              {detail.symbol}
            </Text>
            <Text variant="footnoteSm" color={colors.ink50}>
              {detail.name ?? NO_RECORD}
            </Text>
          </View>

          {/* Reserves, with the age of the claim attached to the claim. */}
          <View style={{ gap: space.s8 }}>
            <Text variant="eyebrow" color={colors.ink30}>
              PROOF OF RESERVES
            </Text>
            {reserves.verified ? (
              <View style={{ gap: space.s8 }}>
                <View style={{ flexDirection: 'row', gap: space.s8, alignItems: 'center' }}>
                  <Tag
                    label={reserves.fullyBacked ? '1:1 backed' : 'Under-backed'}
                    tone={reserves.fullyBacked ? 'up' : 'down'}
                    small
                  />
                  {reserves.stale ? <Tag label="Stale" tone="warn" small /> : null}
                </View>
                <Field label="RATIO" value={`${reserves.ratio.toFixed(4)}x`} />
                <Field
                  label="SHARES HELD"
                  value={`${reserves.sharesHeld.toLocaleString()} against ${reserves.circulatingSupply.toLocaleString(
                    undefined,
                    { maximumFractionDigits: 2 },
                  )} in circulation`}
                />
                <Field
                  label="ATTESTED"
                  value={`${attestationAge(reserves.ageSeconds)} · ${reserves.asOf}`}
                />
                <Field
                  label="CUSTODY"
                  value={
                    reserves.custodians.length > 0
                      ? reserves.custodians.map((c) => `${c.provider} (${c.quantity.toLocaleString()})`).join(', ')
                      : null
                  }
                />
                {/* How the ratio has moved, drawn only from attestations we have recorded. */}
                <ReservesHistoryChart history={history} />
              </View>
            ) : (
              <View style={{ gap: space.s6 }}>
                <Tag label="Backing unverified" tone="warn" small />
                <Text variant="footnoteSm" color={colors.ink50}>
                  {reserves.reason}
                </Text>
              </View>
            )}
          </View>

          {/* What the issuer can do to a holder's tokens. */}
          <View style={{ gap: space.s8 }}>
            <Text variant="eyebrow" color={colors.ink30}>
              ISSUER CONTROLS
            </Text>
            <Field label="CAN SEIZE (PERMANENT DELEGATE)" value={short(issuer.permanentDelegate)} />
            <Field label="CAN FREEZE ACCOUNTS" value={short(issuer.freezeAuthority)} />
            <Field label="CAN MINT" value={short(issuer.mintAuthority)} />
            <Field
              label="CAN PAUSE ALL TRANSFERS"
              value={
                issuer.pausable
                  ? `${short(issuer.pausable.authority)}${issuer.pausable.paused ? ' · PAUSED NOW' : ''}`
                  : null
              }
            />
            <Field
              label="TRANSFER ALLOW-LIST"
              value={issuer.transferHookProgram ? short(issuer.transferHookProgram) : 'None configured'}
            />
          </View>

          {/* What the multiplier has actually paid out, where we have watched long enough to say. */}
          <View style={{ gap: space.s8 }}>
            <Text variant="eyebrow" color={colors.ink30}>
              REINVESTED DIVIDENDS
            </Text>
            {income && yieldLine(income) !== null ? (
              <>
                <Text variant="footnoteSm" color={colors.up}>
                  {yieldLine(income)}
                </Text>
                {income.status === 'measured' && income.excluded.length > 0 ? (
                  <Text variant="footnoteSm" color={colors.ink30}>
                    {`${income.excluded.length} corporate action${
                      income.excluded.length === 1 ? '' : 's'
                    } excluded from this figure — a split hands you more tokens, not more value.`}
                  </Text>
                ) : null}
              </>
            ) : (
              /*
               * No line at all, rather than 0.00%. A window we have not watched long enough is not
               * a window in which the token paid nothing.
               */
              <Text variant="footnoteSm" color={colors.ink30}>
                {income?.status === 'unmeasured' ? income.reason : 'Reading dividend history…'}
              </Text>
            )}
          </View>

          {/* The multiplier, which is how a split or a dividend reaches a holding. */}
          <View style={{ gap: space.s8 }}>
            <Text variant="eyebrow" color={colors.ink30}>
              SCALED UI MULTIPLIER
            </Text>
            <Field
              label="CURRENT"
              value={multiplier.current === null ? null : `${multiplier.current}x`}
            />
            <Field label="IN EFFECT SINCE" value={multiplier.effectiveAt} />
            <Field
              label="SCHEDULED CHANGE"
              value={
                multiplier.pending
                  ? `${multiplier.pending.multiplier}x from ${multiplier.pending.effectiveAt}`
                  : 'None scheduled'
              }
            />
            {multiplier.history.length > 0 ? (
              <View style={{ gap: space.s4 }}>
                <Text variant="eyebrowSm" color={colors.ink30}>
                  RECORDED CHANGES
                </Text>
                {multiplier.history.map((p) => (
                  <Text key={`${p.effectiveAt}-${p.multiplier}`} variant="footnoteSm" color={colors.ink50}>
                    {`${p.multiplier}x from ${p.effectiveAt}`}
                  </Text>
                ))}
              </View>
            ) : (
              <Text variant="footnoteSm" color={colors.ink30}>
                No multiplier changes recorded yet. This is what we have observed, not the token’s
                whole history.
              </Text>
            )}
          </View>
        </View>
      </SheetCard>
    </ScrollView>
  );
}
