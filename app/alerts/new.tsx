/**
 * Add custom alert — PLAN.md 10.9 [G14]. Screen 18's ghost button had no destination.
 *
 * And then it had one that did nothing: the screen built an alert object and called
 * `goBack()`, so it looked like it worked and remembered nothing. An alert that is not
 * persisted is an alert that will not fire.
 */
import React, { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  CloseButton,
  Eyebrow,
  Fill,
  NoteStrip,
  Screen,
  Text,
  border,
  colors,
  radius,
  space,
  typeScale,
} from '@/ui';
import { price as fmtPrice } from '@/format';
import { repos } from '@/data';
import { DEFAULT_BUY, priceableSymbols, resolvePriceable } from '@/data/tradable';
import { usePrice } from '@/data/usePrices';
import { errorText } from '@/data/apiError';


const FIELD_H = 48;

export default function NewAlert() {
  const goBack = useGoBack();
  /*
   * Opened on a symbol, when something already knows which one.
   *
   * The watchlist is where someone is already looking at a market and thinking about a level, and
   * sending them here to type its ticker again is asking them to re-enter what they just tapped.
   * Without a param this is the ordinary blank alert, on the default buy as it always was.
   */
  const { symbol: fromRoute } = useLocalSearchParams<{ symbol?: string }>();
  const [symbol, setSymbol] = useState<string>(
    // NOT uppercased, and not resolved here: rule 3 in `venues/oneinch.ts`. The field's own
    // `resolvePriceable` does that below, against the list of what can actually be priced.
    typeof fromRoute === 'string' && fromRoute.trim() ? fromRoute.trim() : DEFAULT_BUY,
  );

  /*
   * The symbols something can put a price on, so an alert that can never fire is refused HERE —
   * while the user is still looking at the field they typed it into.
   *
   * The server refuses it too, and says so well: "nothing prices NOTATOKEN, so this alert could
   * never fire". But that costs a round trip to learn something the client can know instantly, and
   * the whole point of the rule is to tell someone while there is still someone to tell.
   *
   * `undefined` means the list has not arrived or could not be fetched — the field stays permissive
   * and the server has the final word, which is the same posture `settleableSymbols` takes.
   */
  const [known, setKnown] = useState<Set<string> | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void priceableSymbols().then((s) => {
      if (alive) setKnown(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  /*
   * NOT `.toUpperCase()`. Rule 3 in `venues/oneinch.ts`: no boundary may uppercase a caller's
   * symbol, because the tokenized equities carry a lowercase suffix and `NVDAx` becoming `NVDAX`
   * is how three separate production bugs started. `resolvePriceable` returns the canonical
   * spelling from the list, so typing `nvdax` produces `NVDAx`.
   */
  const sym = resolvePriceable(symbol, known) ?? symbol.trim();
  const unpriceable = known !== undefined && symbol.trim().length > 0 && !resolvePriceable(symbol, known);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  /*
   * Start the level near the price, not at 95.
   *
   * `useState('95')` was a fixture from when the default symbol was a cheap one. Against WETH at
   * $2,490 the screen opened offering "Alert me when WETH is above $95" — an alert that fires the
   * instant it is created, which is the opposite of what an alert is for. Five percent above the
   * live price is a level worth waiting for, and it is a starting point the user edits anyway.
   *
   * With no price to work from there is no sensible number to invent, so the field stays empty and
   * the CTA says "Enter a symbol and a price" — which it already knew how to do.
   */
  const { quote } = usePrice(sym || undefined);
  const [level, setLevel] = useState('');
  const [seededFor, setSeededFor] = useState<string>();
  const suggestion = quote?.price === undefined ? undefined : Math.round(quote.price * 1.05);
  if (suggestion !== undefined && seededFor !== sym) {
    setSeededFor(sym);
    if (level.trim() === '') setLevel(String(suggestion));
  }

  const value = parseFloat(level);
  const valid = sym.length > 0 && !unpriceable && Number.isFinite(value) && value > 0;

  async function create() {
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    try {
      await repos.alerts.create({
        kind: 'price',
        symbol: sym,
        // Formatted as the button above says it: the alert list read "WETH above $2662" beside prices with separators.
        name: `${sym} above ${fmtPrice(value)}`,
        // Once per crossing, not once ever: see the note on the screen below.
        detail: `Each time ${sym} crosses above ${fmtPrice(value)}.`,
        config: { above: value },
      });
      goBack();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="screenTitle">New alert</Text>
        <CloseButton onPress={() => goBack()} />
      </View>

      <Text variant="secondary" style={{ marginTop: space.s10 }}>
        Tells you when a price crosses a level. It never trades.
      </Text>

      {/*
        The kind selector is gone, because it was never real.

        It switched an internal `kind` between price, agent and risk and the form below never
        changed: the same Symbol and Above fields, the same "Alert me when X is above $Y" button.
        Tapping Agent or Risk looked like a dead control — nothing on screen moved — and was worse
        than dead, because it then POSTed `kind: 'agent'` carrying `{ above: 95 }`. The executor
        evaluates an agent alert by looking for an agent and a risk alert by reading the policy,
        so either one would have been created successfully and then failed every time it ran.

        This screen builds a price alert, which is what its first line says. Agent and risk
        alerts need fields this form does not have, so it does not offer to make them half-built.
      */}
      <Fill style={{ marginTop: space.s20, gap: space.s14 }}>
        <Field label="Symbol" value={symbol} onChange={setSymbol} autoCapitalize="characters" />
        <Field label="Above" value={level} onChange={setLevel} keyboard="decimal-pad" />

        {/*
          What the executor's sweep actually does (server/src/alerts/evaluate.ts): it fires when the price
          reaches the level, disarms, re-arms once the price is back under it, and fires again on the next
          crossing. It never turns itself off. This said it did, while /alerts said it goes quiet until the
          condition clears — the second was the true one.
        */}
        <NoteStrip kind="acted">
          Fires each time the price crosses above it, even with the app closed.
        </NoteStrip>

        {error ? (
          <Text variant="secondarySm" color={colors.down}>
            {`That did not save: ${error}`}
          </Text>
        ) : null}
      </Fill>

      <Button
        label={
          valid
            ? `Alert me when ${sym} is above ${fmtPrice(Number(level))}`
            : unpriceable
              ? `Nothing prices ${symbol.trim()}`
              : 'Enter a symbol and a price'
        }
        disabled={!valid}
        loading={busy}
        onPress={() => void create()}
      />
    </Screen>
  );
}

function Field({
  label,
  value,
  onChange,
  keyboard = 'default',
  autoCapitalize = 'none',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  keyboard?: 'default' | 'decimal-pad';
  autoCapitalize?: 'none' | 'characters';
}) {
  return (
    <View style={{ gap: space.s8 }}>
      <Eyebrow small>{label}</Eyebrow>
      <TextInput
        value={value}
        onChangeText={onChange}
        keyboardType={keyboard}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        accessibilityLabel={label}
        style={[
          typeScale.body,
          border.input,
          {
            height: FIELD_H,
            borderRadius: radius.tile,
            backgroundColor: colors.inputBg,
            paddingHorizontal: space.s14,
            color: colors.ink,
          },
        ]}
      />
    </View>
  );
}
