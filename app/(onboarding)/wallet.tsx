/**
 * Sign in and get a wallet — Privy. Every "Sign in" in the app opens this step directly (`returning`), and a person signing
 * back in goes Home afterwards rather than on into funding.
 *
 * Replaces the handoff's KYC screen (screen 8). Its LAYOUT is reused verbatim — the progress
 * header and four status rows, with the same three circle states (done = filled `up` with a
 * check in `upInk`; current = 2pt white ring; pending = 2pt `pending` ring and dimmed text)
 * — because that pattern reads correctly for any sequential setup. Only the steps change.
 *
 * The product point: identity and wallet are one object. The user signs in — an email code, a Google account, an X
 * account, or a wallet they already have (web) — and comes out the other side owning a wallet xorr cannot spend from.
 * Whichever way they came, Privy's account is the same object and the executor knows them by its id, never by an email. The bot's
 * authority over it is a separate on-chain permission, granted on the next screen.
 *
 * Every tick is a fact. The third row read "Network ready · Connected" and was ticked the moment
 * Privy returned an address, with nothing checked, and "Continue — add funds" stayed live after
 * registering the wallet with the executor had failed. The third row is that registration now: done
 * when `/wallet/connect` answers, asked again from here when it does not — and the way on waits for it.
 */
import React, { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import { Icon } from '@/design/Icon';
import {
  BackButton,
  Button,
  Eyebrow,
  Fill,
  NoteStrip,
  Progress,
  Screen,
  Text,
  border,
  colors,
  radius,
  space,
  typeScale,
} from '@/ui';
import { repos } from '@/data';
import { useStore } from '@/state/store';
import { useAuth, useEmailLogin, useSocialLogin, useWalletLogin } from '@/auth/useAuth';
import { SOCIAL_LOGINS, type SocialProvider } from '@/auth/socialLogins';
import { codeFailure, connectFailure, oauthFailure, verifyFailure } from '@/auth/onboardingErrors';
import { NotSignedIn } from '@/data/api';

const STEPS = [
  { label: 'Signed in', detail: 'A code, Google, X, GitHub or your own wallet' },
  { label: 'Wallet created', detail: 'Only you can sign' },
  { label: 'Connected', detail: 'The app can read this wallet' },
  { label: 'Ready to fund', detail: 'Nothing is deposited yet' },
] as const;

/** The step marker. 26pt, 2pt ring — screens 8/9 draw it at this size on both. */
const MARK = 26;
const RING = 2;
const STEP_H = 62;
const FIELD_H = 48;

export default function WalletSetup() {
  const router = useRouter();
  const goBack = useGoBack();
  const { returning } = useLocalSearchParams<{ returning?: string }>();
  const { ready, authenticated, address, createWallet } = useAuth();
  const { sendCode, loginWithCode } = useEmailLogin();
  const social = useSocialLogin();
  const walletLogin = useWalletLogin();
  const setWallet = useStore((s) => s.setWallet);

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Which way in is mid-flight, so only that button spins. */
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();

  /*
   * Registering the address with the executor, kept as results: the address it answered for, and
   * the attempt that failed. Neither is set before asking, so an attempt with no result is one still
   * in flight — and "Try again" is a new attempt rather than a reset.
   */
  const [attempt, setAttempt] = useState(0);
  const [connectedAddress, setConnectedAddress] = useState<string>();
  const [connectFailed, setConnectFailed] = useState<{ attempt: string; message: string }>();
  const attemptKey = `${address ?? ''}#${attempt}`;
  const connected =
    address !== undefined && connectedAddress?.toLowerCase() === address.toLowerCase();
  const connectError =
    !connected && connectFailed?.attempt === attemptKey ? connectFailed.message : undefined;

  // How far through setup the user is — derived, never a counter we increment by hand.
  const step = !authenticated ? 0 : !address ? 1 : !connected ? 2 : 4;
  const done = step >= STEPS.length;

  /*
   * Once Privy has an address AND a session, register it with the executor.
   *
   * `authenticated` is in the guard and the deps because Privy restores the two separately: on a
   * returning visit the address comes back from storage a beat before the access token does, so
   * this fired without one, `api` refused to send an unauthenticated request, and onboarding
   * greeted the user with "Not signed in, so /wallet/connect was not requested." — a developer's
   * sentence, naming an endpoint, on the screen where they had not yet done anything.
   *
   * It was also wrong on its own terms: that is "not yet", not "failed", and the effect re-runs
   * the moment the token lands. The same distinction this app draws everywhere else between a
   * value that is absent and one that could not be read.
   */
  useEffect(() => {
    if (!address || !authenticated) return;
    let alive = true;
    const key = `${address}#${attempt}`;
    repos.wallet
      .connect(address)
      .then((w) => {
        if (!alive) return;
        setWallet(w);
        setConnectedAddress(address);
      })
      .catch((e: unknown) => {
        // A session that has not settled yet is not an error to show anyone.
        if (!alive || e instanceof NotSignedIn) return;
        setConnectFailed({ attempt: key, message: connectFailure(e) });
      });
    return () => {
      alive = false;
    };
  }, [address, authenticated, attempt, setWallet]);

  /**
   * Google or X. Backing out of the provider's sheet is the commonest outcome and answers '' — nothing went wrong, so
   * nothing is said. The wallet is created by the effect above, as it is for an emailed code.
   */
  async function withSocial(provider: SocialProvider, label: string) {
    setPending(provider);
    setError(undefined);
    try {
      await social.login(provider);
      await createWallet();
    } catch (e) {
      setError(oauthFailure(e, label) || undefined);
    } finally {
      setPending(undefined);
    }
  }

  async function send() {
    setBusy(true);
    setError(undefined);
    try {
      await sendCode({ email: email.trim() });
      setCodeSent(true);
    } catch (e) {
      setError(codeFailure(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(undefined);
    try {
      await loginWithCode({ code: code.trim(), email: email.trim() });
      await createWallet();
    } catch (e) {
      setError(verifyFailure(e));
    } finally {
      setBusy(false);
    }
  }

  /*
   * A wallet for a signed-in account that has none. This was `void createWallet()`: no spinner while
   * Privy worked, and a failure went nowhere, so the button looked as if it had done nothing.
   */
  async function create() {
    setBusy(true);
    setError(undefined);
    try {
      await createWallet();
    } catch (e) {
      // `verifyFailure` answers '' for a wallet that already exists — the outcome wanted, not an error.
      setError(verifyFailure(e) || undefined);
    } finally {
      setBusy(false);
    }
  }

  const shownError = error ?? connectError;

  return (
    <Screen>
      {/* Signing back in is not step two of a setup, so it carries no setup progress. */}
      {returning ? <BackButton onPress={() => goBack()} /> : <Progress step={2} total={3} onBack={() => goBack()} />}

      <Text variant="onboardingTitle" style={{ marginTop: space.s26 }}>
        {returning ? 'Welcome back' : 'Your wallet, your keys'}
      </Text>
      {returning ? null : (
        <Text variant="body" color={colors.ink55} style={{ marginTop: space.s10 }}>
          xorr never holds your money. You keep the wallet; the bot gets a separate, limited
          permission to trade inside it — which you can take back at any time.
        </Text>
      )}

      <Fill style={{ marginTop: space.s22 }}>
        {STEPS.map((s, i) => {
          const isDone = i < step;
          const isCurrent = i === step;
          return (
            <View
              key={s.label}
              style={{
                height: STEP_H,
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.s14,
              }}
            >
              <View
                style={{
                  width: MARK,
                  height: MARK,
                  borderRadius: radius.full,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: isDone ? colors.up : 'transparent',
                  borderWidth: isDone ? 0 : RING,
                  borderColor: isCurrent ? colors.ink : colors.pending,
                }}
              >
                {isDone ? (
                  <Icon name="check" size={14} color={colors.upInk} strokeWidth={2.4} />
                ) : null}
              </View>
              <View style={{ flex: 1, gap: space.s2 }}>
                <Text variant="rowPrimary" color={isDone || isCurrent ? colors.ink : colors.ink32}>
                  {s.label}
                </Text>
                <Text
                  variant="secondarySm"
                  color={isDone || isCurrent ? colors.ink38 : colors.ink28}
                >
                  {s.detail}
                </Text>
              </View>
            </View>
          );
        })}

        {!authenticated ? (
          <View style={{ gap: space.s10, marginTop: space.s8 }}>
            {/* The ways in that need nothing typed, first — and gone once a code is on its way to an address. */}
            {!codeSent ? (
              <>
                {SOCIAL_LOGINS.map((s) => (
                  <Button
                    key={s.id}
                    label={`Continue with ${s.label}`}
                    variant="ghost"
                    loading={pending === s.id}
                    disabled={!ready || busy || (!!pending && pending !== s.id)}
                    onPress={() => void withSocial(s.id, s.label)}
                  />
                ))}
                {/* Only where a wallet in another app can actually be reached — web today. */}
                {walletLogin.login ? (
                  <Button
                    label="Continue with a wallet"
                    variant="ghost"
                    disabled={!ready || busy || !!pending}
                    onPress={() => walletLogin.login?.()}
                  />
                ) : null}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10, marginVertical: space.s2 }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: colors.hairline }} />
                  <Text variant="secondarySm" color={colors.ink40}>
                    or an email code
                  </Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: colors.hairline }} />
                </View>
              </>
            ) : null}
            <Field
              label="Email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              editable={!codeSent}
              keyboard="email-address"
            />
            {codeSent ? (
              <Field
                label="Code"
                value={code}
                onChange={setCode}
                placeholder="6-digit code"
                keyboard="number-pad"
              />
            ) : null}
          </View>
        ) : null}

        <NoteStrip kind={authenticated ? 'acted' : 'risk'} style={{ marginTop: space.s16 }}>
          However you sign in is how you get back to this wallet.
        </NoteStrip>

        {shownError ? (
          <Text variant="secondarySm" color={colors.down} style={{ marginTop: space.s14 }}>
            {shownError}
          </Text>
        ) : null}
      </Fill>

      {done ? (
        returning ? (
          <Button label="Continue" onPress={() => router.replace('/')} />
        ) : (
          <Button label="Continue — add funds" onPress={() => router.push('/fund')} />
        )
      ) : !authenticated ? (
        <Button
          label={codeSent ? 'Verify and create wallet' : 'Email me a code'}
          loading={busy || !ready}
          disabled={!!pending || (codeSent ? code.trim().length < 4 : !email.includes('@'))}
          onPress={codeSent ? verify : send}
        />
      ) : !address ? (
        <Button label="Create wallet" loading={busy} onPress={create} />
      ) : connectError ? (
        <Button label="Try again" onPress={() => setAttempt((n) => n + 1)} />
      ) : (
        /* Registering. The step after this one is not offered until the executor has answered. */
        <Button label={returning ? 'Continue' : 'Continue — add funds'} loading />
      )}
    </Screen>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  editable = true,
  keyboard = 'default',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  editable?: boolean;
  keyboard?: 'default' | 'email-address' | 'number-pad';
}) {
  return (
    <View style={{ gap: space.s8 }}>
      <Eyebrow small>{label}</Eyebrow>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.ink35}
        editable={editable}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboard}
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
            opacity: editable ? 1 : 0.6,
          },
        ]}
      />
    </View>
  );
}
