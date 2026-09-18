/**
 * Register this device for push, once, after the user is signed in.
 *
 * `register()` existed and nothing called it, so no device was ever registered and the executor's
 * `send()` had nobody to send to — the whole "the bot interrupts you when it matters" half of the
 * product had no path from an event to a phone.
 *
 * Registration is deliberately tied to having a WALLET rather than to app launch: a push token
 * belongs to an account, and registering before there is one would file it against nobody.
 */
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useStore } from '@/state/store';
import { register, type RegistrationResult } from './index';

export function useRegisterDevice(): RegistrationResult | undefined {
  const wallet = useStore((s) => s.wallet);
  const [result, setResult] = useState<RegistrationResult>();
  // Once per wallet per launch. A token that has not changed does not need re-filing, and the
  // permission prompt must not reappear on every render.
  const doneFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    const address = wallet?.address;
    if (!address || doneFor.current === address) return;
    // Web has no push token to get; asking would produce a prompt with nothing behind it.
    if (Platform.OS === 'web') return;
    doneFor.current = address;
    void register().then((r) => {
      setResult(r);
      /*
       * Say what happened, out loud.
       *
       * The result was going straight into state that nothing rendered, so a registration that
       * failed — permission denied, no FCM on this device, the executor unreachable — was
       * indistinguishable from one that worked. "The bot never told me" is the hardest bug in
       * this product to notice after the fact, so it gets a line in the log at the moment it
       * happens.
       */
      /*
       * Development only, and it is not the real answer.
       *
       * A push registration that failed — permission denied, no FCM on this device, the executor
       * unreachable — is genuinely hard to notice after the fact, which is why this was logged at
       * all. But the console is the one place a user will never look, so shipping the only signal
       * there means the failure is still silent to everyone it affects. `/notifications` renders
       * `result` now, and this line stays behind `__DEV__` for whoever is actually watching a
       * terminal.
       *
       * The token itself is never printed: it is a credential-shaped value, and "it worked" is the
       * whole of what a log needs to say.
       */
      if (__DEV__) {
        console.log(r.ok ? '[push] registered' : `[push] not registered (${r.reason}): ${r.detail}`);
      }
    });
  }, [wallet?.address]);

  return result;
}
