/**
 * The drawer and the screens it opens: down for your profile or an agent's page, and back up where it was when you come
 * back to the screen it rose over.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { RETURN_WITHIN_MS, useChatDrawer } from './chatDrawer';

const drawer = () => useChatDrawer.getState();

beforeEach(() => {
  useChatDrawer.setState({ open: false, agent: null, leftFrom: null, leftAt: null });
});

describe('useChatDrawer', () => {
  it('comes back up on the conversation it left once the screen it rose over is in view again', () => {
    drawer().show('Earnings Desk');
    drawer().leave('/', 1_000);
    expect(drawer()).toMatchObject({ open: false, agent: 'Earnings Desk' });

    // The screen it opened, and one opened from there: still away.
    drawer().returned('/earnings', 2_000);
    drawer().returned('/asset/NVDAc', 3_000);
    expect(drawer().open).toBe(false);

    drawer().returned('/', 4_000);
    expect(drawer()).toMatchObject({ open: true, agent: 'Earnings Desk', leftFrom: null, leftAt: null });
  });

  it('comes back on the list when it left from the list', () => {
    drawer().show();
    drawer().leave('/markets', 0);
    drawer().returned('/profile', 10);
    drawer().returned('/markets', 20);
    expect(drawer()).toMatchObject({ open: true, agent: null });
  });

  it('stays down when it was closed rather than left', () => {
    drawer().show('Yield Keeper');
    drawer().hide();
    drawer().returned('/', 5_000);
    expect(drawer().open).toBe(false);
  });

  it('does not rise over a screen visited again long after, and forgets it did leave', () => {
    drawer().show();
    drawer().leave('/', 0);
    drawer().returned('/', RETURN_WITHIN_MS + 1);
    expect(drawer()).toMatchObject({ open: false, leftFrom: null, leftAt: null });
  });

  it('comes back once: closed again, a later return to the same screen leaves it down', () => {
    drawer().show();
    drawer().leave('/', 0);
    drawer().returned('/', 10);
    drawer().hide();
    drawer().returned('/', 20);
    expect(drawer().open).toBe(false);
  });

  it('opening it by hand forgets an earlier leave', () => {
    drawer().show();
    drawer().leave('/', 0);
    drawer().show('Drawdown Guard');
    drawer().hide();
    drawer().returned('/', 10);
    expect(drawer().open).toBe(false);
  });
});
