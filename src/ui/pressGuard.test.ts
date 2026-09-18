/**
 * That one press cannot become two records.
 *
 * Test plan item G7. The end-to-end version — double-tapping a primary action in the browser and
 * counting the rows — is the real check, and the guard underneath it had no test at all, so a
 * regression would have been invisible until it created somebody two identical alerts. Which is
 * exactly what it did once: see the note in `Button.tsx` about "Alert me when WETH is above $9000".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DOUBLE_TAP_MS, createPressGuard, pressGuardFor, resetSharedGuards } from './pressGuard';

describe('createPressGuard', () => {
  it('lets the first press through', () => {
    expect(createPressGuard().take()).toBe(true);
  });

  it('drops every press while one is in flight', () => {
    const g = createPressGuard();
    expect(g.take()).toBe(true);
    // The case that matters: dispatched in the same tick, before any state could update.
    expect(g.take()).toBe(false);
    expect(g.take()).toBe(false);
  });

  it('lets the next press through once released', () => {
    const g = createPressGuard();
    g.take();
    g.release();
    expect(g.take()).toBe(true);
  });

  it('reports whether it is held, so the loading effect can clear it', () => {
    const g = createPressGuard();
    expect(g.held).toBe(false);
    g.take();
    expect(g.held).toBe(true);
    g.release();
    expect(g.held).toBe(false);
  });

  it('is safe to release when nothing is held', () => {
    const g = createPressGuard();
    g.release();
    expect(g.take()).toBe(true);
  });

  it('gives each button its own lock', () => {
    // Two guards must not interfere — one busy screen cannot wedge another screen's button.
    const a = createPressGuard();
    const b = createPressGuard();
    a.take();
    expect(b.take()).toBe(true);
  });

  it('holds long enough to swallow a double tap, and not long enough to be felt', () => {
    // A synchronous handler has no promise to await, so the lock is released on a timer instead.
    // 800ms is well past a double tap (~300ms) and under the ~1s that reads as an unresponsive UI.
    expect(DOUBLE_TAP_MS).toBeGreaterThan(300);
    expect(DOUBLE_TAP_MS).toBeLessThanOrEqual(1000);
  });
});

/*
 * The hole a real browser found, and the reason `pressGuardFor` exists.
 *
 * The lock used to live in a `useRef`, so it belonged to one component INSTANCE. A press that
 * unmounts its own button — pressing "Try again", which puts the screen into its loading state and
 * takes `ErrorState` with it — throws the lock away, and the button that comes back holds a fresh
 * unlocked one. On the deployed app a real double-click on "Try again" produced two `/limits`
 * requests 11 milliseconds apart, against one for a single click. Seven passing unit tests said
 * nothing about it, because every one of them used a single guard object.
 */
describe('a guard that survives its button being rebuilt', () => {
  beforeEach(() => resetSharedGuards());

  it('hands the same lock back for the same testID', () => {
    const first = pressGuardFor('error-retry');
    expect(first.take()).toBe(true);

    // The remount: a new component asks for its guard and must not get a fresh, unlocked one.
    const afterRemount = pressGuardFor('error-retry');
    expect(afterRemount.take()).toBe(false);
    expect(afterRemount).toBe(first);
  });

  it('keeps different buttons independent', () => {
    expect(pressGuardFor('error-retry').take()).toBe(true);
    // A second control pressed inside the window is a different action, not a double tap.
    expect(pressGuardFor('boundary-retry').take()).toBe(true);
  });

  it('gives an unkeyed button exactly what it had before', () => {
    // No `testID` means no sharing — two instances, two locks, today's behaviour unchanged.
    const a = pressGuardFor(undefined);
    const b = pressGuardFor(undefined);
    expect(a).not.toBe(b);
    expect(a.take()).toBe(true);
    expect(b.take()).toBe(true);
  });

  it('unlocks on release, so the button is not dead after one press', () => {
    const g = pressGuardFor('error-retry');
    expect(g.take()).toBe(true);
    g.release();
    expect(pressGuardFor('error-retry').take()).toBe(true);
  });
});
