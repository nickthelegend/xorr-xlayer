/**
 * The store — state.md "Store", split into the slices state.md itself names.
 *
 * state.md: "The prototype holds everything in one flat store. In a real app, split it as noted."
 * Defaults are exactly the handoff's.
 *
 * Changed by the pivot:
 *   - `kyc` removed. Non-custodial means there is no KYC step; wallet setup replaced it (PLAN §7).
 *   - `wallet`, `delegation`, `strategies` added.
 */
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { remember as rememberRecent } from '@/markets/recents';
import {
  CAP_MAX,
  CAP_MIN,
  CAP_STEP,
  SL_MAX,
  SL_MIN,
  TPSL_STEP,
  TP_MAX,
  TP_MIN,
  WEIGHT_STEP,
  keypadPress,
} from './derived';
import { AMOUNT_DECIMALS } from '@/markets/amount';
import type { Delegation, Wallet } from '../data/types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Kill float drift on 0.5-step values: 1.0 - 0.5 - 0.5 must be exactly 0, not 1.1e-16. */
const round1 = (v: number) => Math.round(v * 10) / 10;

// ── Agent config (on this device until signed; PLAN §6.7 makes the cap and duration the policy) ──
//
// `auto` and `risk` lived here too, behind a "Trade Autonomously" switch and a "Risk Level" pill that
// nothing signed, sent or read. Both went with their controls — see app/bot/[id]/settings.tsx. A device
// that persisted them carries two inert keys until the store next writes.
type AgentConfigSlice = {
  runFor: number;
  cap: number;
  stocksPaused: boolean;
  cycleRunFor: () => void;
  bumpCap: (dir: 1 | -1) => void;
  toggleStocksPaused: () => void;
};

// ── Market UI (client-only) ──
type MarketUiSlice = {
  tab: number;
  mkt: number;
  tab5: number;
  setTab: (i: number) => void;
  setMkt: (i: number) => void;
  setTab5: (i: number) => void;
};

// ── Order params (per position) ──
type OrderSlice = {
  tp: number;
  sl: number;
  orderAmt: string;
  side: 'buy' | 'sell';
  lev: number;
  closePct: number;
  bumpTp: (dir: 1 | -1) => void;
  setTp: (v: number) => void;
  setSl: (v: number) => void;
  bumpSl: (dir: 1 | -1) => void;
  pressKey: (key: string) => void;
  setOrderAmt: (v: string) => void;
  setSide: (s: 'buy' | 'sell') => void;
  setLev: (l: number) => void;
  setClosePct: (p: number) => void;
};

// ── Onboarding profile (server-persisted) ──
type OnboardingSlice = {
  goals: string[];
  riskQ: number;
  weights: number[];
  approved: boolean;
  walletStep: number;
  dep: number;
  method: number;
  toggleGoal: (g: string) => void;
  setRiskQ: (i: number) => void;
  bumpWeight: (i: number, delta: number) => void;
  setApproved: (v: boolean) => void;
  advanceWalletStep: () => void;
  setDep: (n: number) => void;
  setMethod: (i: number) => void;
};

// ── Agents & alerts ──
type AgentsSlice = {
  hired: Record<string, boolean>;
  alerts: Record<string, boolean>;
  decision: null | 'yes' | 'no';
  killed: boolean;
  toggleHire: (name: string) => void;
  toggleAlert: (name: string) => void;
  setDecision: (d: null | 'yes' | 'no') => void;
  setKilled: (v: boolean) => void;
};

// ── Views ──
type ViewsSlice = {
  actFilter: number;
  lbSort: number;
  /**
   * Markets looked at recently, newest first — a device preference, not an account's.
   *
   * On the device rather than the executor deliberately: it is a convenience, not a record. Losing
   * it costs a few taps, and sending "which markets is this person interested in" to a server that
   * has no other reason to know would be collecting something for nothing. `markets/recents.ts`
   * holds the rules.
   */
  recentMarkets: string[];
  rememberMarket: (symbol: string) => void;
  btLook: number;
  btCapital: number;
  /**
   * Every amount on every screen masked, from a tap on Home's balance (FEATURES.md #47).
   *
   * The device's, not the person's, so it is not in `ACCOUNT_KEYS` and signing out leaves it as it was: it is about who
   * can see this phone, not whose wallet is on it.
   */
  balancesHidden: boolean;
  setActFilter: (i: number) => void;
  setLbSort: (i: number) => void;
  setBtLook: (i: number) => void;
  bumpBtCapital: (dir: 1 | -1) => void;
  toggleBalancesHidden: () => void;
};

// ── Wallet & delegation (the pivot) ──
type WalletSlice = {
  wallet: Wallet | null;
  /**
   * The user has read the recovery screen and acknowledged what holds the key.
   *
   * Screen 20's row said "Not backed up" as a literal, so it said it forever — including to
   * a user who had just been through recovery. This is the state behind that row.
   */
  recoveryBackedUp: boolean;
  setRecoveryBackedUp: (v: boolean) => void;
  delegation: Delegation | null;
  /**
   * Which address `delegation` was read for.
   *
   * Nothing recorded this, which was harmless while an account had one wallet and became a hazard
   * the moment the switcher shipped: a switch re-points every executor call at the second account
   * while the store goes on holding the first account's permission. Safety reads that value, so
   * the failure is a live cap shown for an account that never granted one.
   *
   * `accounts/delegationScope.ts` turns the pair into the three states a screen actually needs —
   * granted, none, and NOT ASKED — because `null` already means "this address granted nothing" and
   * cannot also mean "we have not looked".
   */
  delegationAddress: string | null;
  setWallet: (w: Wallet | null) => void;
  /**
   * Has the executor been asked whether this user has a wallet yet?
   *
   * Distinct from `wallet === null`, which conflates "no account" with "not asked". The entry gate
   * redirects to onboarding on a null wallet, so acting before the answer arrives sent signed-in
   * users back through sign-up.
   */
  walletChecked: boolean;
  setWalletChecked: (v: boolean) => void;
  /** The permission and whose it is, together — they must never be set apart. */
  setDelegation: (d: Delegation | null, forAddress: string | null) => void;
  /**
   * Switch to another address on the same account.
   *
   * Everything account-scoped in this store — the permission, the stop switch, the caps, the
   * approvals, the onboarding answers — belongs to ONE address. Carrying any of it across a switch
   * means showing one account's safety state while the executor acts on another, so the switch
   * drops all of it and lets each be read again for the account now in use.
   */
  switchAccount: (w: Wallet) => void;
  /**
   * Forget what this device holds about the signed-in person, and keep what belongs to the device.
   *
   * Sign-out cleared `wallet` alone, so the next account on the same phone inherited the last one's "Done" on Recovery
   * (a claim that a recovery step was taken, made to someone who never took it) along with its stop switch, its
   * limits and its onboarding answers. Screen and list preferences stay: they are the device's.
   */
  forgetAccount: () => void;
};

export type Store = AgentConfigSlice &
  MarketUiSlice &
  OrderSlice &
  OnboardingSlice &
  AgentsSlice &
  ViewsSlice &
  WalletSlice;

/** What belongs to the signed-in person rather than to this device. `forgetAccount` puts each back to its default. */
const ACCOUNT_KEYS = [
  'wallet',
  'walletChecked',
  'delegation',
  // Beside `delegation`, always: a permission without the address it belongs to is worse than none.
  'delegationAddress',
  'recoveryBackedUp',
  'killed',
  'hired',
  'alerts',
  'decision',
  'runFor',
  'cap',
  'stocksPaused',
  'goals',
  'riskQ',
  'weights',
  'approved',
  'walletStep',
  'dep',
  'method',
] as const satisfies readonly (keyof Store)[];

export const useStore = create<Store>()(
  persist(
    (set, get, api) => ({
      // ── agent config — state.md defaults ──
      // $100 a day for 7 days (`agentControls.runFor[2]`): the demo's limits (PLAN.md D19) and a small first permission.
      runFor: 2,
      cap: 100,
      stocksPaused: false,
      cycleRunFor: () => set((s) => ({ runFor: (s.runFor + 1) % 4 })),
      bumpCap: (dir) => set((s) => ({ cap: clamp(s.cap + dir * CAP_STEP, CAP_MIN, CAP_MAX) })),
      toggleStocksPaused: () => set((s) => ({ stocksPaused: !s.stocksPaused })),

      // ── market UI ──
      tab: 0,
      mkt: 0, // Stocks — the tokenized shares this app trades (2026-09-25; was Commodities, a class with no prices)
      tab5: 1, // state.md: default Markets
      setTab: (i) => set({ tab: i }),
      setMkt: (i) => set({ mkt: i }),
      setTab5: (i) => set({ tab5: i }),

      // ── order params ──
      tp: 1.0,
      sl: -1.0,
      orderAmt: '250',
      side: 'buy',
      lev: 5,
      closePct: 50,
      bumpTp: (dir) => set((s) => ({ tp: round1(clamp(s.tp + dir * TPSL_STEP, TP_MIN, TP_MAX)) })),
      bumpSl: (dir) => set((s) => ({ sl: round1(clamp(s.sl + dir * TPSL_STEP, SL_MIN, SL_MAX)) })),

      // Screen 6 reads the rule that is actually armed on the executor and seeds the steppers

      // from it. The same clamp as the bumps: a rule stored before the bounds changed must not

      // put the ruler marker off the end of its track.

      setTp: (v) => set({ tp: round1(clamp(v, TP_MIN, TP_MAX)) }),

      setSl: (v) => set({ sl: round1(clamp(v, SL_MIN, SL_MAX)) }),
      // The ticket is a dollar field, so it stops at the cent (`AMOUNT_DECIMALS`).
      pressKey: (key) => set((s) => ({ orderAmt: keypadPress(s.orderAmt, key, { decimals: AMOUNT_DECIMALS }) })),
      setOrderAmt: (v) => set({ orderAmt: v }),
      setSide: (side) => set({ side }),
      setLev: (lev) => set({ lev }),
      setClosePct: (closePct) => set({ closePct }),

      // ── onboarding ──
      goals: ['Grow long term'],
      riskQ: 1,
      weights: [55, 30, 15],
      approved: false,
      walletStep: 0,
      dep: 500,
      method: 0,
      toggleGoal: (g) =>
        set((s) => ({
          goals: s.goals.includes(g) ? s.goals.filter((x) => x !== g) : [...s.goals, g],
        })),
      setRiskQ: (riskQ) => set({ riskQ }),
      bumpWeight: (i, delta) =>
        set((s) => {
          const weights = s.weights.slice();
          weights[i] = clamp((weights[i] ?? 0) + delta * WEIGHT_STEP, 0, 100);
          // state.md: "any weight edit sets approved = false".
          return { weights, approved: false };
        }),
      setApproved: (approved) => set({ approved }),
      advanceWalletStep: () => set((s) => ({ walletStep: Math.min(4, s.walletStep + 1) })),
      setDep: (dep) => set({ dep }),
      setMethod: (method) => set({ method }),

      // ── agents & alerts ──
      // Empty, and read by nothing: who is hired is the executor's answer (`/agents`). The prototype's sample said Momentum Scout.
      hired: {},
      // Empty. It held two of the design prototype's sample alerts, on markets this app cannot trade, as switches that
      // were "on" for alerts nobody had set; the alerts themselves come from the executor.
      alerts: {},
      decision: null,
      killed: false,
      toggleHire: (name) => set((s) => ({ hired: { ...s.hired, [name]: !s.hired[name] } })),
      toggleAlert: (name) => set((s) => ({ alerts: { ...s.alerts, [name]: !s.alerts[name] } })),
      setDecision: (decision) => set({ decision }),
      setKilled: (killed) => set({ killed }),

      // ── views ──
      actFilter: 0,
      lbSort: 0,
      recentMarkets: [],
      rememberMarket: (symbol) =>
        set((st) => ({ recentMarkets: rememberRecent(st.recentMarkets, symbol) })),
      btLook: 1,
      btCapital: 5000,
      balancesHidden: false,
      setActFilter: (actFilter) => set({ actFilter }),
      setLbSort: (lbSort) => set({ lbSort }),
      setBtLook: (btLook) => set({ btLook }),
      bumpBtCapital: (dir) =>
        set((s) => ({ btCapital: clamp(s.btCapital + dir * 1000, 1000, 50000) })),
      toggleBalancesHidden: () => set((s) => ({ balancesHidden: !s.balancesHidden })),

      // ── wallet & delegation ──
      wallet: null,
      recoveryBackedUp: false,
      setRecoveryBackedUp: (recoveryBackedUp) => set({ recoveryBackedUp }),
      delegation: null,
      delegationAddress: null,
      setWallet: (wallet) => set({ wallet }),
      walletChecked: false,
      setWalletChecked: (walletChecked) => set({ walletChecked }),
      setDelegation: (delegation, delegationAddress) => set({ delegation, delegationAddress }),
      switchAccount: (wallet) => {
        /*
         * Forget first, then set the wallet.
         *
         * `forgetAccount` resets every account-scoped key to its default — the same set sign-out
         * clears, for the same reason — and the new wallet is written after, so the switch does not
         * leave the app without one for a render.
         */
        get().forgetAccount();
        set({ wallet, walletChecked: true });
      },
      forgetAccount: () => {
        const initial = api.getInitialState();
        set(Object.fromEntries(ACCOUNT_KEYS.map((key) => [key, initial[key]])) as Partial<Store>);
      },
    }),
    {
      name: 'xorr-store',
      storage: createJSONStorage(() => AsyncStorage),
      /**
       * PLAN.md 3.11: UI prefs persist to AsyncStorage. Secrets never touch it — the wallet
       * key material lives in expo-secure-store (src/wallet), and only the PUBLIC address is
       * mirrored here so the shell can render without unlocking anything.
       */
      partialize: (s) => ({
        runFor: s.runFor,
        cap: s.cap,
        mkt: s.mkt,
        tab5: s.tab5,
        tab: s.tab,
        actFilter: s.actFilter,
        lbSort: s.lbSort,
        // Survives a sign-out with the rest of the device's preferences: it says nothing about an
        // account, and a shared phone's next user learns only which markets exist.
        recentMarkets: s.recentMarkets,
        btLook: s.btLook,
        btCapital: s.btCapital,
        balancesHidden: s.balancesHidden,
        goals: s.goals,
        riskQ: s.riskQ,
        weights: s.weights,
        approved: s.approved,
        hired: s.hired,
        alerts: s.alerts,
        killed: s.killed,
        wallet: s.wallet,
        recoveryBackedUp: s.recoveryBackedUp,
      }),
    },
  ),
);

/**
 * Whether the persisted store has finished loading from AsyncStorage.
 *
 * The entry gate reads `wallet` to decide between onboarding and the tab shell. Reading it before
 * hydration makes a returning user flash the splash screen, so the gate waits for this.
 */
export function useHasHydrated(): boolean {
  // Subscribed via useSyncExternalStore rather than an effect: hydration is external state, and
  // reading it directly avoids a synchronous setState-in-effect on every mount.
  return useSyncExternalStore(
    (cb) => useStore.persist.onFinishHydration(cb),
    () => useStore.persist.hasHydrated(),
    () => false,
  );
}

/** Number of hired agents — drives "n of 4 hired" and the kill-switch explanation. */
export function hiredCount(hired: Record<string, boolean>): number {
  return Object.values(hired).filter(Boolean).length;
}

