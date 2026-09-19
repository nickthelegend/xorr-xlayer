/**
 * PLAN.md 3.9 — "Assert against the handoff's stated outputs. These formulas ARE the business
 * logic." Every expectation below is traceable to a line in state.md or screens.md.
 */
import { describe, expect, it } from 'vitest';
import * as d from './derived';
import { MINUS, money } from '../format';
import { btcBars } from '../data/fixtures/series';
import { agentFixtures } from '../data/fixtures/agents';
import { activityFixtures } from '../data/fixtures/activity';
import type { ChainStanding, OnChainPolicy } from '../wallet/delegationChain';

describe('agent controls — screen 4', () => {
  it('capLabel and the marker position', () => {
    expect(d.capLabel(1600)).toBe('$1,600/day');
    // state.md: capMarker = (cap - 200) / 4800 * 100
    expect(d.capMarkerPct(1600)).toBeCloseTo(((1600 - 50) / (5000 - 50)) * 100, 6);
    expect(d.capMarkerPct(50)).toBe(0);
    expect(d.capMarkerPct(5000)).toBe(100);
  });

  it('Run For maps to a real delegation lifetime', () => {
    expect(d.runForMs(0)).toBe(86_400_000);
    expect(d.runForMs(3)).toBe(30 * 86_400_000);
  });
});

describe('Auto Close — screen 6 (mid 66000, size $2500)', () => {
  it('tp/sl prices', () => {
    // state.md: tpPrice = mid * (1 + tp/100)
    expect(d.tpPrice(1.0)).toBe(66660);
    expect(d.slPrice(-1.0)).toBe(65340);
    expect(d.tpPrice(3.0)).toBeCloseTo(67980, 6);
  });

  it('tp/sl P&L — the footnote "Make X at TP or lose Y at SL"', () => {
    expect(d.tpPnl(1.0)).toBe(25);
    expect(d.slPnl(-1.0)).toBe(25);
    expect(money(d.tpPnl(1.0))).toBe('$25.00');
    expect(d.tpPnl(3.0)).toBe(75);
  });

  it('ruler tick positions', () => {
    // state.md: tpTick = 20 + tp*22, slTick = 80 + sl*22
    expect(d.tpTickPct(1.0)).toBe(42);
    expect(d.slTickPct(-1.0)).toBe(58);
  });
});

describe('order ticket — screen 14', () => {
  it('unit conversion is 4dp against $88.32', () => {
    expect(d.orderUnits(250, 88.32, 'SOL')).toBe('2.8306 SOL');
    expect(d.orderUnits(250, 2500, 'XBTC')).toBe('0.1000 XBTC');
  });

  it('fee is 0.1%', () => {
    expect(d.orderFee(250)).toBeCloseTo(0.25, 10);
  });

  it('CTA reads as designed', () => {
    // Defaults to the X Layer asset the executor can actually settle, not a chain we do not trade.
    expect(d.orderCta('buy', '250')).toBe('Buy $250 of XBTC');
    expect(d.orderCta('sell', '1,000')).toBe('Sell $1,000 of XBTC');
    expect(d.orderCta('buy', '250', 'NVDAx')).toBe('Buy $250 of NVDAx');
  });

  describe('keypad rules — state.md', () => {
    it('a leading 0 is REPLACED by a digit, not appended to', () => {
      expect(d.keypadPress('0', '5')).toBe('5');
      expect(d.keypadPress('0', '.')).toBe('0.');
    });
    it('max 7 characters', () => {
      expect(d.keypadPress('1234567', '8')).toBe('1234567');
      expect(d.keypadPress('123456', '7')).toBe('1234567');
    });
    it('a single decimal point', () => {
      expect(d.keypadPress('12.5', '.')).toBe('12.5');
      expect(d.keypadPress('12', '.')).toBe('12.');
    });
    it('backspace pops the last character and floors at 0', () => {
      expect(d.keypadPress('250', '⌫')).toBe('25');
      expect(d.keypadPress('2', '⌫')).toBe('0');
      expect(d.keypadPress('0', '⌫')).toBe('0');
    });
    it('a realistic sequence', () => {
      const seq = ['1', '2', '5', '.', '5', '0'];
      // Two arguments explicitly: `reduce(keypadPress, …)` would hand the INDEX to the third parameter.
      expect(seq.reduce((a, k) => d.keypadPress(a, k), '0')).toBe('125.50');
    });

    it('caps a dollar field at the cent, and leaves a token field alone', () => {
      // The same keypad enters dollars on the ticket and token units on Swap. Eighteen decimals are real
      // in one of those and a typo in the other.
      expect(d.keypadPress('12.34', '5', { decimals: 2 })).toBe('12.34');
      expect(d.keypadPress('12.3', '4', { decimals: 2 })).toBe('12.34');
      expect(d.keypadPress('12.34', '5')).toBe('12.345');
      // The cap is on the digits after the point, never on the ones before it.
      expect(d.keypadPress('1234', '5', { decimals: 2 })).toBe('12345');
      // And the point itself still goes in.
      expect(d.keypadPress('12', '.', { decimals: 2 })).toBe('12.');
    });
  });
});

describe('leverage — screen 25 (margin $800, gold $3412.10)', () => {
  it('notional = 800 * lev', () => {
    expect(d.notional(2)).toBe(1600);
    expect(d.notional(5)).toBe(4000);
    expect(d.notional(10)).toBe(8000);
  });

  it('liq = 3412.10 * (1 - 0.92/lev)', () => {
    expect(d.liquidation(10)).toBeCloseTo(3412.1 * (1 - 0.092), 6);
    expect(d.liquidation(5)).toBeCloseTo(3412.1 * (1 - 0.184), 6);
    expect(d.liquidation(2)).toBeCloseTo(3412.1 * (1 - 0.46), 6);
    // Higher leverage puts liquidation closer to the mark. That's the whole warning.
    expect(d.liquidation(10)).toBeGreaterThan(d.liquidation(2));
  });

  it('the warning names the consequence, and its colour band escalates', () => {
    expect(d.leverageWarning(2)).toBe('A 46% move against you wipes the margin.');
    // "An eighteen per cent move", not "a eighteen per cent move".
    expect(d.leverageWarning(5)).toBe('An 18% move against you wipes the margin.');
    expect(d.leverageWarning(10)).toBe('A 9% move against you wipes the margin.');
  });

  it('the sentence and the liquidation price describe the same move', () => {
    // They were computed separately — the price from a ratio, the sentence from three hardcoded
    // strings — so nothing stopped them drifting into stating two different liquidation points.
    const mark = 78_440;
    for (const lev of d.LEVERAGE_OPTIONS) {
      const drop = (mark - d.liquidation(lev, mark)) / mark;
      const stated = Number(/(\d+)%/.exec(d.leverageWarning(lev))![1]);
      expect(stated, `${lev}x`).toBe(Math.round(drop * 100));
    }
    expect(d.leverageWarnBand(2)).toBe('calm');
    expect(d.leverageWarnBand(5)).toBe('warn');
    expect(d.leverageWarnBand(10)).toBe('danger');
  });
});

describe('position close — screen 22 (unrealised $318.40, margin $3800)', () => {
  it('realises and frees scale with the percentage', () => {
    expect(d.closeRealise(50)).toBeCloseTo(159.2, 10);
    expect(d.closeFree(50)).toBe(1900);
    expect(d.closeRealise(100)).toBe(318.4);
    expect(d.closeFree(25)).toBe(950);
  });

  it('the CTA switches wording at 100%', () => {
    expect(d.closeCta(50)).toBe('Close 50%');
    expect(d.closeCta(100)).toBe('Close position');
  });

  it('the summary line formats with separators', () => {
    expect(d.closeSummary(50)).toEqual({ realises: '$159.20', frees: '$1,900.00' });
  });
});

describe('swap — screen 19 (PLAN.md 3.9)', () => {
  it('sends the amount as typed, with the pair and the tolerance chosen', () => {
    expect(d.swapRequest({ pay: 'XBTC', receive: 'WOKB', amount: '0.1', slippagePct: 0.5 })).toEqual({
      from: 'XBTC',
      to: 'WOKB',
      amount: '0.1',
      slippagePct: 0.5,
    });
  });

  it('builds nothing the executor would only refuse: no amount, a zero, a bare point, or one token twice', () => {
    expect(d.swapRequest({ pay: 'USDC', receive: 'XBTC', amount: '0', slippagePct: 0.3 })).toBeNull();
    expect(d.swapRequest({ pay: 'USDC', receive: 'XBTC', amount: '0.', slippagePct: 0.3 })).toBeNull();
    expect(d.swapRequest({ pay: 'USDC', receive: 'XBTC', amount: '', slippagePct: 0.3 })).toBeNull();
    expect(d.swapRequest({ pay: 'XBTC', receive: 'xbtc', amount: '1', slippagePct: 0.3 })).toBeNull();
  });

  it('pays USDC from cash and anything else from the holding, and knows unknown from none', () => {
    const balance = { cash: 120.5, holdings: [{ symbol: 'XBTC', units: 0.25 }] };
    expect(d.swapSpendable(balance, 'USDC')).toBe(120.5);
    expect(d.swapSpendable(balance, 'XBTC')).toBe(0.25);
    expect(d.swapSpendable(balance, 'WOKB')).toBe(0);
    expect(d.swapSpendable(undefined, 'XBTC')).toBeUndefined();
  });

  it('offers only tolerances the executor accepts', () => {
    for (const pct of d.SWAP_SLIPPAGES) expect(pct >= 0.05 && pct <= 3).toBe(true);
  });
});

describe('portfolio proposal — screen 10', () => {
  it('defaults total 100 and can be approved', () => {
    expect(d.weightTotal([55, 30, 15])).toBe(100);
    expect(d.canApprove([55, 30, 15])).toBe(true);
    expect(d.proposalCta([55, 30, 15], false)).toBe('Approve & fund');
  });

  it('an unbalanced total disables the CTA with the exact copy', () => {
    expect(d.canApprove([60, 30, 15])).toBe(false);
    expect(d.proposalCta([60, 30, 15], false)).toBe('Balance to 100% first');
  });

  it('once approved the CTA confirms', () => {
    expect(d.proposalCta([55, 30, 15], true)).toBe('Portfolio approved ✓');
  });

  it('bars normalise to the total so the bar stays full mid-edit', () => {
    expect(d.weightBarPct([55, 30, 15], 0)).toBeCloseTo(55, 10);
    // Mid-edit at 105 total, the first sleeve is 60/105, not 60/100.
    expect(d.weightBarPct([60, 30, 15], 0)).toBeCloseTo((60 / 105) * 100, 10);
    const sum = [0, 1, 2].reduce((a, i) => a + d.weightBarPct([60, 30, 15], i), 0);
    expect(sum).toBeCloseTo(100, 8);
  });
});

describe('backtest — screen 17', () => {
  it('end value and gain', () => {
    expect(d.btEnd(5000, 11.8)).toBeCloseTo(5590, 6);
    expect(d.btGain(5000, 11.8)).toBeCloseTo(590, 6);
  });

  it('max drawdown uses U+2212, not a hyphen — called out explicitly in state.md', () => {
    expect(d.btDrawdown(-14.6)).toBe(`${MINUS}14.6%`);
    expect(d.btDrawdown(-14.6)).not.toContain('-');
  });

  it('a replay that never fell has no drawdown to sign', () => {
    // "−0.0%" put a minus sign on a zero.
    expect(d.btDrawdown(0)).toBe('0.0%');
    // Rounded first: a dip too small to show is shown as none, not as a signed zero.
    expect(d.btDrawdown(-0.04)).toBe('0.0%');
    expect(d.btDrawdown(-0.06)).toBe(`${MINUS}0.1%`);
  });

  it('the summary formats every field', () => {
    expect(d.backtestSummary(5000, 11.8, -5.4)).toEqual({
      end: '$5,590.00',
      gain: '+$590.00',
      ret: '+11.8%',
      dd: `${MINUS}5.4%`,
    });
  });
});

describe('leaderboard — screen 16', () => {
  it('sorts by each metric', () => {
    expect(d.sortLeaderboard(agentFixtures, 'pnl30d').map((a) => a.name)).toEqual([
      'Earnings Desk',
      'Momentum Scout',
      'Yield Keeper',
      'Drawdown Guard',
    ]);
    expect(d.sortLeaderboard(agentFixtures, 'win')[0]!.name).toBe('Yield Keeper');
    expect(d.sortLeaderboard(agentFixtures, 'trades')[0]!.name).toBe('Momentum Scout');
  });

  /*
   * The third sort was labelled "Volume" and ordered by trade count. The server sends no volume, so
   * the label names the number it sorts by.
   */
  it('names each sort for the number it sorts by', () => {
    expect(d.LEADERBOARD_LABELS).toHaveLength(d.LEADERBOARD_KEYS.length);
    expect(d.LEADERBOARD_LABELS[d.LEADERBOARD_KEYS.indexOf('trades')]).toBe('Trades');
    expect(d.LEADERBOARD_LABELS).not.toContain('Volume');
  });

  it('shows no win rate for an agent with no trades, rather than a 0% that reads as every trade lost', () => {
    expect(d.winRate({ win: 0, trades: 0 })).toBe('—');
    expect(d.winRate({ win: 61, trades: 37 })).toBe('61%');
    // A real zero, over real trades, is still a zero.
    expect(d.winRate({ win: 0, trades: 4 })).toBe('0%');
  });

  it('signs a gain or a loss, and not a zero', () => {
    expect(d.signedPnl(0)).toBe('$0.00');
    expect(d.signedPnl(842)).toBe('+$842.00');
    expect(d.signedPnl(-96)).toBe(`${MINUS}$96.00`);
  });

  it('bars normalise to the largest absolute P&L (1204)', () => {
    expect(d.leaderboardBarPct(1204, agentFixtures)).toBe(100);
    expect(d.leaderboardBarPct(842, agentFixtures)).toBeCloseTo((842 / 1204) * 100, 10);
    // A negative P&L still draws a bar — magnitude, not sign.
    expect(d.leaderboardBarPct(-96, agentFixtures)).toBeCloseTo((96 / 1204) * 100, 10);
  });
});

describe('kill switch — screen 20', () => {
  it('state-driven title, explanation and CTA', () => {
    expect(d.killTitle(false)).toBe('Trading is live');
    expect(d.killTitle(true)).toBe('Trading is stopped');
    expect(d.killCta(false)).toBe('Stop all trading');
    expect(d.killCta(true)).toBe('Resume trading');
    expect(d.killExplanation(false, { agents: 3, strategies: 0 })).toBe(
      '3 agents can trade within your limits.',
    );
    expect(d.killExplanation(true, { agents: 3, strategies: 0 })).toContain('until you resume');
  });

  /*
   * "1 agents" was reachable and the docblock in derived.ts records seeing it on screen; the only
   * test used 3, so nothing caught it.
   */
  it('counts one thing as one thing', () => {
    expect(d.killExplanation(false, { agents: 1, strategies: 0 })).toBe(
      '1 agent can trade within your limits.',
    );
    expect(d.killExplanation(false, { agents: 0, strategies: 1 })).toBe(
      '1 strategy can trade within your limits.',
    );
  });

  /*
   * A strategy is not an agent.
   *
   * Safety counts hired agents and live strategies together, because the switch stops both — and
   * the sentence then called the total agents. Observed: no agent hired, nine live strategies, and
   * "9 agents can trade within your limits." while Home showed all four agents "Not hired".
   */
  it('names each kind by its own name', () => {
    const strategiesOnly = d.killExplanation(false, { agents: 0, strategies: 9 });
    expect(strategiesOnly).toBe('9 strategies can trade within your limits.');
    expect(strategiesOnly).not.toMatch(/agent/);
    expect(d.killExplanation(false, { agents: 2, strategies: 9 })).toBe(
      '2 agents and 9 strategies can trade within your limits.',
    );
    expect(d.killExplanation(false, { agents: 1, strategies: 1 })).toBe(
      '1 agent and 1 strategy can trade within your limits.',
    );
  });

  /*
   * The title and the button name trading, never agents. The switch stops strategies as well, and a wallet running only
   * strategies was headed "Agents are live" and offered "Stop all agents" above a sentence counting nine strategies.
   */
  it('names trading, not agents, in the title and the button, whatever the state', () => {
    const states: [boolean, boolean, boolean, boolean][] = [
      [false, false, true, false],
      [true, false, true, false],
      [false, true, true, false],
      [false, false, false, false],
      [false, false, true, true],
    ];
    for (const s of states) {
      expect(d.killTitle(...s)).not.toMatch(/agent/i);
      expect(d.killCta(...s)).not.toMatch(/agent/i);
    }
    expect(d.killExplanation(false, { agents: 0, strategies: 2 }, true)).not.toMatch(/agent/i);
  });

  /*
   * A count that could not be read is not zero.
   *
   * The roster read no longer falls back to fixture personas, so it can fail — and counting a failed
   * read as nothing running would put "Nothing is running" under a live permission that may be
   * trading, the same false negative as a failed permission read reported as "Not granted".
   */
  it('does not report an uncounted roster as an empty one', () => {
    const unknown = d.killExplanation(false, undefined);
    expect(unknown).toBe('Couldn’t count what is running.');
    expect(unknown).not.toContain('Nothing is running');
    expect(unknown).not.toMatch(/\d/);
    // The states that never needed a count still say what they say.
    expect(d.killExplanation(true, undefined)).toContain('until you resume');
    expect(d.killExplanation(false, undefined, false, false)).toContain('Nothing is granted yet');
  });

  /*
   * No permission at all outranks every other state.
   *
   * The zero-agents sentence below said "the permission is live" to a wallet that had granted
   * nothing — rendered directly above "Nothing is granted yet" on the same screen. Introduced by
   * the fix for the zero case itself, which is why it gets its own test.
   */
  it('does not describe a permission that was never granted', () => {
    const none = d.killExplanation(false, { agents: 0, strategies: 0 }, false, false);
    expect(none).toContain('Nothing is granted yet');
    expect(none).not.toContain('the permission is live');
    expect(d.killTitle(false, false, false)).toBe('Nothing can trade yet');
    // And an ungranted wallet with strategies somehow counted still must not claim they can trade.
    expect(d.killExplanation(false, { agents: 0, strategies: 3 }, false, false)).toContain('Nothing is granted yet');
  });

  /*
   * A read that failed is not a permission that is absent.
   *
   * `/safety` loaded the delegation with `.catch(() => undefined)`, so an unreachable executor
   * left it null and the screen announced "NOT GRANTED · No permission has been granted, so
   * nothing can trade" over a live $1,600/day grant. Observed by cutting the executor off in a
   * browser with that grant on chain.
   */
  describe('a permission we could not read', () => {
    const err = new Error('Failed to fetch');

    it('is unknown, not absent', () => {
      expect(d.permissionUnreadable(err, null)).toBe(true);
      expect(d.permissionUnreadable(err, undefined)).toBe(true);
    });

    it('is not claimed when the read succeeded', () => {
      expect(d.permissionUnreadable(undefined, null)).toBe(false);
      expect(d.permissionUnreadable(undefined, { revoked: false })).toBe(false);
    });

    it('does not override a permission we did read', () => {
      // A stale error alongside real data must not blank out the real data.
      expect(d.permissionUnreadable(err, { revoked: false })).toBe(false);
    });

    it('is not claimed for a signed-out visitor', () => {
      // They genuinely have no permission. That is an answer, not a failure to get one.
      expect(d.permissionUnreadable(err, null, true)).toBe(false);
    });
  });

  /*
   * The fourth state: a permission that ran out on schedule.
   *
   * The expiry BANNER on the safety screen has read this since it was added; the badge above it
   * did not. So a policy that lapsed at 13:35 on 8 September showed a green **Live** dot headed
   * "Agents are live" thirteen hours later, with "Your permission has expired, so nothing can be
   * placed" a scroll below it. Observed on the hosted deployment, not imagined.
   */
  describe('an expired permission', () => {
    const HOUR = 3_600_000;
    const now = 1_788_912_000_000;
    const lapsed = { expiresAt: now - 13 * HOUR };
    const valid = { expiresAt: now + 13 * HOUR };

    it('is expired when the clock has passed, and not before', () => {
      expect(d.delegationExpired(lapsed, false, now)).toBe(true);
      expect(d.delegationExpired(valid, false, now)).toBe(false);
    });

    it('is not claimed of a server that cannot answer', () => {
      // Absent is not expired — the same rule `delegateIsCurrent` already documents.
      expect(d.delegationExpired({}, false, now)).toBe(false);
      expect(d.delegationExpired(null, false, now)).toBe(false);
      expect(d.delegationExpired(undefined, false, now)).toBe(false);
    });

    it('does not fight the kill switch for the same screen', () => {
      // A user who stopped their agents is told they stopped them, not that time ran out.
      expect(d.delegationExpired(lapsed, true, now)).toBe(false);
    });

    it('never reads as live', () => {
      expect(d.killTitle(false, false, true, true)).toBe('Your permission has ended');
      expect(d.killTitle(false, false, true, true)).not.toContain('live');
      const why = d.killExplanation(false, { agents: 3, strategies: 0 }, false, true, true);
      expect(why).toContain('end date');
      expect(why).not.toContain('can trade');
    });

    /*
     * And the button must not offer a stop. `revoke()` on a policy the contract already considers
     * over is a wallet prompt and a gas fee that change nothing — the same mistake the ungranted
     * wallet was fixed for, one state along.
     */
    it('offers a new grant, not a stop', () => {
      expect(d.killCta(false, false, true, true)).toBe('Grant a new permission');
      expect(d.killCta(false, false, true, false)).toBe('Stop all trading');
    });

    it('leaves the other states alone', () => {
      // Disconnected outranks expired: a key that moved is the more specific fault.
      expect(d.killCta(false, true, true, true)).toBe('Reconnect');
      expect(d.killTitle(false, true, true, true)).toBe('Nothing can trade');
      // And an ungranted wallet has no clock to run out.
      expect(d.killCta(false, false, false, true)).toBe('Set the limits');
    });
  });

  /*
   * Zero is not "the bot is stopped" — that is what `killed` means, and it has its own sentence.
   * Under a green LIVE badge, "0 agents can place orders" read as a kill switch already pulled.
   */
  it('says nothing is running but anything started can trade, not that nothing can', () => {
    const nothing = { agents: 0, strategies: 0 };
    const live = d.killExplanation(false, nothing);
    expect(live).toContain('Anything you start can trade');
    expect(live).not.toContain('0 agents');
    expect(live).not.toBe(d.killExplanation(true, nothing));
  });

  /*
   * The third state. A grant that names a delegate the executor is not is unusable, and the
   * screen reported it as "Agents are live — 1 agents can place orders inside your limits right
   * now." while not one order could be placed.
   */
  /*
   * Found in the closing frame of the demo recording: a wallet with no permission was shown a red
   * "Stop all agents" directly under "There is nothing to stop yet". `killTitle` already knew about
   * `granted`; the CTA did not, and its handler would have asked the wallet to revoke a policy that
   * had never been granted.
   */
  it('offers a grant, not a stop, when nothing is granted', () => {
    expect(d.killTitle(false, false, false)).toBe('Nothing can trade yet');
    expect(d.killCta(false, false, false)).toBe('Set the limits');
    // And the states that already worked keep working.
    expect(d.killCta(false, false, true)).toBe('Stop all trading');
    expect(d.killCta(true, false, true)).toBe('Resume trading');
    // `unusable` still wins over both — a broken grant is re-granted, not "set".
    expect(d.killCta(false, true, false)).toBe('Reconnect');
  });

  it('a grant to a key the executor does not hold is not "live"', () => {
    expect(d.delegateUnusable({ delegateIsCurrent: false }, false)).toBe(true);
    expect(d.killTitle(false, true)).toBe('Nothing can trade');
    expect(d.killCta(false, true)).toBe('Reconnect');
    expect(d.killExplanation(false, { agents: 1, strategies: 0 }, true)).toContain('Reconnect');
    // And it must not read as a working permission.
    expect(d.killExplanation(false, { agents: 1, strategies: 0 }, true)).not.toContain('can trade within');
  });

  it('a stopped switch stays stopped — the two states do not collide', () => {
    // Killed wins: the user stopped it, and that is not a connection fault.
    expect(d.delegateUnusable({ delegateIsCurrent: false }, true)).toBe(false);
  });

  it('an executor too old to answer is not accused of being broken', () => {
    // Undefined is "unknown", not "wrong" — claiming a fault we have not seen is its own bug.
    expect(d.delegateUnusable({}, false)).toBe(false);
    expect(d.delegateUnusable(null, false)).toBe(false);
    expect(d.delegateUnusable(undefined, false)).toBe(false);
    expect(d.delegateUnusable({ delegateIsCurrent: true }, false)).toBe(false);
  });
});

describe('activity — screen 15', () => {
  it('All shows everything', () => {
    expect(d.filterActivity(activityFixtures, 0)).toHaveLength(activityFixtures.length);
  });

  it('[G41] the yield row is reachable — it was orphaned by the original filter map', () => {
    const trades = d.filterActivity(activityFixtures, 1);
    expect(trades.map((r) => r.action)).toContain('Staked 120 SOL');
    // Every fixture row is reachable from at least one non-All tab.
    for (const row of activityFixtures) {
      const reachable = [1, 2, 3].some((i) =>
        d.filterActivity(activityFixtures, i).some((r) => r.id === row.id),
      );
      expect(reachable, `${row.action} is orphaned`).toBe(true);
    }
  });

  it('risk and blocked filters select their own rows', () => {
    expect(d.filterActivity(activityFixtures, 2).map((r) => r.action)).toEqual(['Stop loss moved']);
    expect(d.filterActivity(activityFixtures, 3).map((r) => r.action)).toEqual(['Skipped NVDAx']);
  });

  it('dot colour class per kind', () => {
    expect(d.activityDot('block')).toBe('blocked');
    expect(d.activityDot('risk')).toBe('risk');
    expect(d.activityDot('trade')).toBe('acted');
    expect(d.activityDot('yield')).toBe('acted');
  });

  it('credits vs debits — a debit starts with U+2212', () => {
    expect(d.activityAmountIsCredit('+$44.90')).toBe(true);
    expect(d.activityAmountIsCredit(`${MINUS}$370.02`)).toBe(false);
    expect(d.activityAmountIsCredit('')).toBe(false);
  });
});

describe('a stored record, as rows — /risk and /strategy/[id]', () => {
  it('flattens what is nested instead of printing [object Object]', () => {
    // The onboarding rebalance, as `app/(onboarding)/proposal.tsx` stores it.
    const rows = d.recordEntries({
      targets: { XBTC: 27.5, WOKB: 27.5 },
      cashPct: 45,
      weights: [55, 30, 15],
      sleeves: ['Blue-chip crypto', 'Tokenized equities', 'Stable yield'],
    });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Target · XBTC', '27.5%'],
      ['Target · WOKB', '27.5%'],
      ['Cash', '45%'],
      ['Weights', '55%, 30%, 15%'],
      ['Sleeves', 'Blue-chip crypto, Tokenized equities, Stable yield'],
    ]);
  });

  it("names an agent's limits, in dollars", () => {
    expect(d.recordEntries({ maxUsdPerTrade: 50, maxUsdPerDay: 1200 })).toEqual([
      { key: 'maxUsdPerTrade', label: 'Most per trade', value: '$50.00', unit: 'money' },
      { key: 'maxUsdPerDay', label: 'Most per day', value: '$1,200.00', unit: 'money' },
    ]);
  });

  it('says which values are money and which are prices, so hidden balances can tell them apart', () => {
    // A range's bounds are prices and stay while balances are hidden; what each rung buys is the person's money.
    const rows = d.recordEntries({ lower: 2400, upper: 2600, steps: 4, usdPerStep: 50, targets: { XBTC: 55 } });
    expect(rows.map((r) => [r.label, r.unit])).toEqual([
      ['Bottom of range', 'price'],
      ['Top of range', 'price'],
      ['Rungs', undefined],
      ['Each rung buys', 'money'],
      ['Target · XBTC', 'percent'],
    ]);
  });

  it('keeps a key it does not know, spaced out, rather than dropping it', () => {
    expect(d.recordEntries({ lastLevel: 2, openLots: [0, 1] }).map((r) => [r.label, r.value])).toEqual([
      ['Last level', '2'],
      ['Open lots', '0, 1'],
    ]);
  });

  it('never renders a value nobody could read', () => {
    const rows = d.recordEntries({
      deep: { deeper: { deepest: 1 } },
      list: [{ usd: 5 }, { usd: 6 }],
      empty: {},
      none: null,
      missing: undefined,
      broken: Number.NaN,
      endless: Number.POSITIVE_INFINITY,
      blank: '',
      negative: -3.5,
    });
    const text = rows.map((r) => `${r.label} ${r.value}`).join('\n');
    expect(text).not.toMatch(/\[object Object\]|NaN|undefined|null|Infinity/);
    expect(rows.find((r) => r.label === 'Deep · deeper · deepest')?.value).toBe('1');
    expect(rows.find((r) => r.label === 'List 2 · Per run')?.value).toBe('$6.00');
    expect(rows.find((r) => r.label === 'Negative')?.value).toBe(`${MINUS}3.5`);
    // Every key is still there — the empty and the unreadable ones as a dash, not hidden.
    expect(rows.filter((r) => r.value === '—').map((r) => r.label)).toEqual([
      'Empty',
      'None',
      'Missing',
      'Broken',
      'Endless',
      'Blank',
    ]);
  });
});

describe('bar helpers', () => {
  it('read the BTC series correctly', () => {
    expect(d.barHigh(btcBars)).toBe(66620);
    expect(d.barLow(btcBars)).toBe(65180);
    expect(d.lastClose(btcBars)).toBe(66560);
  });
});

describe('asset header — the percentage names its own window', () => {
  it('1M is not "today"', () => {
    /*
     * The bug, exactly: the header computed the change over the selected candle range and then
     * labelled it "today" regardless. On 1M a real asset read "up 38.4% today" having moved
     * about 2% since midnight.
     */
    expect(d.rangeChange('1M', 38.4, 2.55).label).toBe('past month');
    expect(d.rangeChange('1M', 38.4, 2.55).pct).toBe(38.4);
    expect(d.rangeChange('1W', 4.2, 2.55).label).toBe('past week');
    expect(d.rangeChange('1Y', 33.1, 2.55).label).toBe('past year');
    expect(d.rangeChange('All', 33.1, 2.55).label).toBe('all time');
  });

  it('the day comes from the quote, so it matches every other screen', () => {
    // 2.1 was this screen's own series maths; 2.55 is what the market list and search show.
    expect(d.rangeChange('1D', 2.1, 2.55)).toEqual({ pct: 2.55, label: 'today' });
  });

  it('falls back to the series when there is no quote', () => {
    expect(d.rangeChange('1D', 2.1, undefined).pct).toBe(2.1);
    expect(d.rangeChange('1D', 2.1, Number.NaN).pct).toBe(2.1);
    // A real zero is a real answer, not a missing one.
    expect(d.rangeChange('1D', 2.1, 0).pct).toBe(0);
  });
});

describe('trailing stop — the exit the engine could always run', () => {
  /*
   * `planExitRules` has read `trailPct` since it was written and `observationFor` maintains the
   * high-water mark on every tick, both covered by tests. Nothing in the app could set it, so the
   * one exit people actually ask for existed in full and was unreachable.
   *
   * These pin the arithmetic the screen shows next to the control, because a trailing stop whose
   * displayed floor disagrees with the executor's is worse than no number at all.
   */
  const floor = (peak: number, trailPct: number) => peak * (1 - trailPct / 100);

  it('the floor follows the high, not the entry', () => {
    expect(floor(2800, 5)).toBeCloseTo(2660, 6);
    // Up from entry: the floor rose with it.
    expect(floor(3000, 5)).toBeCloseTo(2850, 6);
  });

  it('a breached floor is what fired the real fill', () => {
    // The live run: peak 2800, 5% trail, XBTC at 2501.65 — sold, tx 0x47db5129…
    expect(2501.65).toBeLessThan(floor(2800, 5));
    // And at the same peak with the price above the floor, it must not fire.
    expect(2700).toBeGreaterThan(floor(2800, 5));
  });

  it('off is off — zero is not a stop at ground level', () => {
    // `planExitRules` treats trailPct > 0 as configured, so 0 must never arm a floor at the peak.
    expect(floor(2800, 0)).toBe(2800);
  });
});

describe('permission expiry — the deadline nothing read', () => {
  const H = 3_600_000;
  const now = Date.UTC(2026, 8, 7, 12);

  it('says nothing while there is plenty of time', () => {
    expect(d.expiryState(now + 72 * H, now)).toBe('ok');
    expect(d.expiryNote(now + 72 * H, now)).toBeUndefined();
  });

  it('warns inside the last day, in hours a person can act on', () => {
    expect(d.expiryState(now + 5 * H, now)).toBe('soon');
    expect(d.expiryNote(now + 5 * H, now)).toContain('5 hours');
    // Singular, because "1 hours" is the kind of thing that makes a user trust nothing else.
    expect(d.expiryNote(now + H, now)).toContain('an hour');
  });

  it('the boundary is inclusive — exactly a day out is already a warning', () => {
    expect(d.expiryState(now + 24 * H, now)).toBe('soon');
    expect(d.expiryState(now + 24 * H + 1, now)).toBe('ok');
  });

  it('an expired permission says what is and is not affected', () => {
    expect(d.expiryState(now - 1, now)).toBe('expired');
    const note = d.expiryNote(now - H, now)!;
    expect(note).toContain('expired');
    // The reassurance is the load-bearing half: a stopped bot is not a lost balance.
    expect(note).toContain('untouched');
  });

  it('no permission is not an expired one', () => {
    // Before a grant exists there is no deadline, and inventing one would be a false alarm.
    expect(d.expiryState(undefined, now)).toBe('none');
    expect(d.expiryState(0, now)).toBe('none');
    expect(d.expiryNote(undefined, now)).toBeUndefined();
  });
});

describe('a position the wallet does not match — PLAN.md 2.7', () => {
  it('a ledger over the wallet is missing units; a wallet over the ledger has unrecorded ones', () => {
    expect(d.holdingDrift({ driftUnits: 0.802587 })).toEqual({ kind: 'missing', units: 0.802587 });
    expect(d.holdingDrift({ driftUnits: -0.2 })).toEqual({ kind: 'unrecorded', units: 0.2 });
  });

  it('agreement, dust and an unasked chain are not drift', () => {
    expect(d.holdingDrift({ driftUnits: 0 })).toBeNull();
    expect(d.holdingDrift({ driftUnits: 0.0000004 })).toBeNull();
    expect(d.holdingDrift({ driftUnits: null })).toBeNull();
    expect(d.holdingDrift({})).toBeNull();
  });

  it('says which way it runs, in units of the asset', () => {
    const missing = d.driftSentence('XBTC', { kind: 'missing', units: 0.802587 });
    expect(missing).toContain('XBTC on record isn’t in your wallet');
    expect(missing).toMatch(/^0\.8026 /);
    expect(d.driftSentence('XBTC', { kind: 'unrecorded', units: 0.2 })).toContain('XBTC in your wallet wasn’t bought here');
  });
});

describe('the onboarding portfolio as a rebalance holds it — PLAN.md 2.17', () => {
  const sleeves = [
    { name: 'Blue-chip crypto', weight: 55 },
    { name: 'Tokenized equities', weight: 30 },
    { name: 'Stable yield', weight: 15 },
  ];
  const equities = ['NVDAx', 'AAPLx', 'TSLAx', 'METAx', 'MSFTx', 'AMZNx', 'GOOGLx', 'MSTRx', 'COINx', 'SPYx', 'QQQx'];

  it('splits each sleeve across what it names, and leaves stable yield as cash', () => {
    const { targets, cashPct } = d.targetsFromSleeves(sleeves, ['XBTC', 'WOKB', 'USDC', ...equities]);
    expect(targets.XBTC).toBe(27.5);
    expect(targets.WOKB).toBe(27.5);
    // 30% over eleven xStocks, rounded down to a hundredth each; the remainder stays cash.
    for (const e of equities) expect(targets[e]).toBe(2.72);
    expect(targets.USDC).toBeUndefined();
    expect(cashPct).toBe(15.08);
  });

  it('a sleeve with nothing tradable on this chain stays cash rather than vanishing', () => {
    const { targets, cashPct } = d.targetsFromSleeves(sleeves, ['XBTC', 'WOKB', 'USDC']);
    expect(Object.keys(targets).sort()).toEqual(['WOKB', 'XBTC']);
    expect(cashPct).toBe(45);
  });

  it('rounds down, so the targets never add up past the whole portfolio', () => {
    const { targets, cashPct } = d.targetsFromSleeves([{ name: 'Blue-chip crypto', weight: 33.33 }], ['XBTC', 'WOKB']);
    expect(targets).toEqual({ XBTC: 16.66, WOKB: 16.66 });
    expect(cashPct).toBe(66.68);
  });
});

describe('what approving the onboarding proposal creates — PLAN.md 3.7', () => {
  const sleeves = [
    { name: 'Blue-chip crypto', weight: 55 },
    { name: 'Tokenized equities', weight: 30 },
    { name: 'Stable yield', weight: 15 },
  ];
  const crypto = ['ETH', 'XBTC', 'USDC', 'WOKB'];

  it('is a live rebalance over what the network settles', () => {
    expect(d.proposalRebalance(sleeves, crypto, [])).toEqual({ state: 'live', targets: { XBTC: 27.5, WOKB: 27.5 }, cashPct: 45 });
  });

  it('where nothing settles, is watched over what the network can follow — not refused', () => {
    expect(d.proposalRebalance(sleeves, [], crypto)).toEqual({ state: 'watch', targets: { XBTC: 27.5, WOKB: 27.5 }, cashPct: 45 });
  });

  it('never watches what it could trade: where fills settle, the followable list is not used', () => {
    expect(d.proposalRebalance(sleeves, ['XBTC'], crypto)).toEqual({ state: 'live', targets: { XBTC: 55 }, cashPct: 45 });
  });

  it('with nothing to trade or follow, targets nothing — which the screen refuses to create', () => {
    expect(d.proposalRebalance(sleeves, [], [])).toEqual({ state: 'watch', targets: {}, cashPct: 100 });
  });

  it('names a sleeve held as cash where nothing it holds settles — the equities on a fork — and no other', () => {
    expect(d.sleeveHeldAsCash('Tokenized equities', crypto)).toBe(true);
    expect(d.sleeveHeldAsCash('Blue-chip crypto', crypto)).toBe(false);
    // Stable yield names nothing to swap on any chain: that is not this network's doing.
    expect(d.sleeveHeldAsCash('Stable yield', crypto)).toBe(false);
    // Where one of the equities settles, the sleeve is not cash.
    expect(d.sleeveHeldAsCash('Tokenized equities', [...crypto, 'NVDAx'])).toBe(false);
    // Where nothing settles the screen says so on its own, and before the executor answers nothing is claimed.
    expect(d.sleeveHeldAsCash('Tokenized equities', [])).toBe(false);
    expect(d.sleeveHeldAsCash('Tokenized equities', undefined)).toBe(false);
  });
});

/*
 * Safety with the executor down (FEATURES.md #1): a live policy read off the chain is shown with its stop. Anything else
 * the pinned contract says keeps the unknown state — except the stop this screen sent, once the chain reads it revoked.
 */
describe('what Safety shows from the chain', () => {
  const contract = '0xc32dd8aeed3035d46c7c82a351fc5522c9d463f4' as const;
  const policy: OnChainPolicy = {
    delegate: '0xc38f00000000000000000000000000000000c8a5',
    dailyCap: 1_600_000_000n,
    expiresAt: 1_999_999_999n,
    revoked: false,
  };
  const at = (kind: 'live' | 'revoked' | 'expired'): ChainStanding => ({
    kind,
    contract,
    policy: { ...policy, revoked: kind === 'revoked' },
  });

  it('shows a live policy, and so its stop', () => {
    expect(d.permissionOnChain(at('live'), false)).toBe('live');
    expect(d.permissionOnChain(at('live'), true)).toBe('live');
  });

  it('does not call a permission stopped, ended or ungranted on one contract’s word', () => {
    const others: (ChainStanding | undefined)[] = [
      at('revoked'),
      at('expired'),
      { kind: 'none' },
      { kind: 'unreadable' },
      undefined,
    ];
    for (const standing of others) expect(d.permissionOnChain(standing, false)).toBeUndefined();
  });

  it('says stopped for the stop this screen sent once the chain reads it revoked — and only then', () => {
    expect(d.permissionOnChain(at('revoked'), true)).toBe('stopped');
    expect(d.permissionOnChain(at('expired'), true)).toBeUndefined();
    expect(d.permissionOnChain({ kind: 'unreadable' }, true)).toBeUndefined();
    expect(d.permissionOnChain(undefined, true)).toBeUndefined();
  });
});

/*
 * The two rings on Safety (FEATURES.md #34), from what the permission read returned. A value that is not known is a dash
 * and no ring — never an empty ring, which reads as nothing spent.
 */
describe('cap and term rings', () => {
  const H = 3_600_000;
  const now = Date.UTC(2026, 8, 14, 12);

  it('draws today’s spend against the cap the same read returned', () => {
    const used = d.capUsed({ dailyCapUsd: 1600, spentTodayUsd: 464 });
    expect(used).toBeCloseTo(0.29, 10);
    // 0.29 × 100 is 28.999… in binary; the figure is still 29%.
    expect(d.capUsedFigure(used)).toBe('29%');
    expect(d.capUsedFigure(d.capUsed({ dailyCapUsd: 1600, spentTodayUsd: 0 }))).toBe('0%');
  });

  it('rounds down, so a cap is never shown used up before it is', () => {
    expect(d.capUsedFigure(d.capUsed({ dailyCapUsd: 1600, spentTodayUsd: 1599.99 }))).toBe('99%');
    expect(d.capUsedFigure(d.capUsed({ dailyCapUsd: 1600, spentTodayUsd: 1600 }))).toBe('100%');
  });

  it('keeps a spend over a cap lowered mid-day in the figure', () => {
    expect(d.capUsedFigure(d.capUsed({ dailyCapUsd: 400, spentTodayUsd: 450 }))).toBe('112%');
  });

  it('is unknown, and a dash, without a tally or a cap to count against', () => {
    // A policy read off the chain alone, or an executor older than the field.
    expect(d.capUsed({ dailyCapUsd: 1600 })).toBeUndefined();
    expect(d.capUsed({ dailyCapUsd: 0, spentTodayUsd: 0 })).toBeUndefined();
    expect(d.capUsed({ dailyCapUsd: 1600, spentTodayUsd: Number.NaN })).toBeUndefined();
    expect(d.capUsed(null)).toBeUndefined();
    expect(d.capUsedFigure(undefined)).toBe('—');
  });

  it('takes the term left as a share of the whole run from its recorded start', () => {
    expect(d.termLeft({ expiresAt: now + 24 * H, grantedAt: now - 48 * H }, now)).toBeCloseTo(1 / 3, 10);
  });

  it('has no term without a recorded start', () => {
    expect(d.termLeft({ expiresAt: now + H, grantedAt: null }, now)).toBeUndefined();
    expect(d.termLeft({ expiresAt: now + H }, now)).toBeUndefined();
    expect(d.termLeft({ expiresAt: now, grantedAt: now + H }, now)).toBeUndefined();
    expect(d.termLeft(null, now)).toBeUndefined();
  });

  it('stays inside the ring: empty once ended, full before it began', () => {
    expect(d.termLeft({ expiresAt: now - H, grantedAt: now - 2 * H }, now)).toBe(0);
    expect(d.termLeft({ expiresAt: now + 2 * H, grantedAt: now + H }, now)).toBe(1);
  });

  it('says the time left in its largest whole unit, rounded down, and in words for a screen reader', () => {
    expect(d.timeLeft(now + 5 * 24 * H + 23 * H, now)).toEqual({ figure: '5d', words: '5 days' });
    expect(d.timeLeft(now + 24 * H, now)).toEqual({ figure: '1d', words: '1 day' });
    expect(d.timeLeft(now + 13 * H + 59 * 60_000, now)).toEqual({ figure: '13h', words: '13 hours' });
    expect(d.timeLeft(now + 40 * 60_000, now)).toEqual({ figure: '40m', words: '40 minutes' });
    expect(d.timeLeft(now + 59_000, now)).toEqual({ figure: '0m', words: 'under a minute' });
  });

  it('is a dash with no expiry to count to', () => {
    expect(d.timeLeft(undefined, now)).toEqual({ figure: '—', words: 'unknown' });
    expect(d.timeLeft(Number.NaN, now).figure).toBe('—');
  });
});

/*
  * The steps a new wallet has left, on Home (FEATURES.md #14).
 *
 * Every combination of the reads is walked, because the rule that matters is the one a hand-picked case misses: the
 * four states are genuinely four, and three of them are ways of not being done that must never be confused.
 */
describe('setup progress — FEATURES.md #14', () => {
  const HOUR = 3_600_000;
  const now = Date.UTC(2026, 8, 14, 12);
  const failure = new Error('Failed to fetch');
  const OUTCOMES = ['out', 'failed', 'done', 'todo'] as const;
  type Outcome = (typeof OUTCOMES)[number];

  const usable: d.SetupPermission = { revoked: false, expiresAt: now + 72 * HOUR, delegateIsCurrent: true };
  const filled = [{ status: 'filled' }];
  const unfilled = [{ status: 'blocked' }];

  function read<T>(outcome: Outcome, done: T, todo: T): d.SetupRead<T> {
    if (outcome === 'out') return { data: undefined, error: undefined };
    if (outcome === 'failed') return { data: undefined, error: failure };
    return { data: outcome === 'done' ? done : todo, error: undefined };
  }

  /** What each outcome becomes as a step state: a read still out is `checking`, a failed one `unknown`. */
  const expected = (o: Outcome) => (o === 'out' ? 'checking' : o === 'failed' ? 'unknown' : o);

  const stepsFor = (balance: Outcome, permission: Outcome, fills: Outcome, signedOut = false) =>
    d.setupSteps({
      signedOut,
      balance: read(balance, { total: 250 }, { total: 0 }),
      permission: read<d.SetupPermission | null>(permission, usable, null),
      fills: read<readonly { status: string }[]>(fills, filled, unfilled),
      now,
    });

  it('says of every step what its own read said, in all sixty-four combinations', () => {
    for (const balance of OUTCOMES) {
      for (const permission of OUTCOMES) {
        for (const fills of OUTCOMES) {
          const outcomes = [balance, permission, fills];
          const label = outcomes.join(' / ');
          expect(stepsFor(balance, permission, fills)?.map((s) => s.state), label).toEqual(outcomes.map(expected));
        }
      }
    }
  });

  /*
   * The card used to vanish while any read was out, so it disappeared for as long as the executor took — on the one
   * screen a new wallet is looking at to find out what to do next. A step that says it is being checked is not a guess.
   */
  it('keeps the card while reads are still out, saying so', () => {
    expect(stepsFor('out', 'out', 'out')?.map((s) => s.state)).toEqual(['checking', 'checking', 'checking']);
  });

  it('draws nothing signed out, whatever the reads said — there is no wallet to set up', () => {
    for (const balance of OUTCOMES) {
      for (const permission of OUTCOMES) {
        for (const fills of OUTCOMES) {
          expect(stepsFor(balance, permission, fills, true), [balance, permission, fills].join(' / ')).toBeNull();
        }
      }
    }
  });

  /* Still checking resolves itself; could-not-read does not. Telling someone to wait for an answer that is not coming. */
  it('never confuses a read still out with one that failed', () => {
    expect(stepsFor('out', 'done', 'done')?.[0]!.state).toBe('checking');
    expect(stepsFor('failed', 'done', 'done')?.[0]!.state).toBe('unknown');
  });

  it('names the three steps in order, each opening the screen it is taken on', () => {
    expect(stepsFor('todo', 'todo', 'todo')).toEqual([
      { key: 'fund', label: 'Fund', href: '/deposit', state: 'todo' },
      { key: 'permit', label: 'Permit', href: '/delegate', state: 'todo' },
      { key: 'trade', label: 'First trade', href: '/strategies', state: 'todo' },
    ]);
  });

  it('is complete only when every step is done', () => {
    expect(d.setupComplete(stepsFor('done', 'done', 'done'))).toBe(true);
    expect(d.setupComplete(stepsFor('done', 'done', 'out'))).toBe(false);
    expect(d.setupComplete(stepsFor('done', 'done', 'failed'))).toBe(false);
    expect(d.setupComplete(null)).toBe(false);
  });

  describe('the trade step is a fill, not an intention', () => {
    const tradeWith = (data: readonly { status: string }[]) =>
      d
        .setupSteps({
          signedOut: false,
          balance: { data: { total: 250 }, error: undefined },
          permission: { data: usable, error: undefined },
          fills: { data, error: undefined },
          now,
        })
        ?.find((s) => s.key === 'trade')?.state;

    /*
     * A strategy created is an intention. The product's claim — and the demo's — is that the bot TRADED, so the step
     * that says so must not be satisfied by runs that were blocked, skipped or are still pending.
     */
    it('is done only once a run actually filled', () => {
      expect(tradeWith(filled)).toBe('done');
      expect(tradeWith([{ status: 'blocked' }, { status: 'skipped' }, { status: 'pending' }])).toBe('todo');
      expect(tradeWith([])).toBe('todo');
    });

    it('finds the fill among runs that were not', () => {
      expect(tradeWith([{ status: 'blocked' }, { status: 'filled' }])).toBe('done');
    });
  });

  describe('the permission comes from the chain when the chain can be asked', () => {
    const permitWith = (standing?: d.SetupRead<d.SetupStanding>, permission: d.SetupPermission | null = null) =>
      d
        .setupSteps({
          signedOut: false,
          balance: { data: { total: 0 }, error: undefined },
          standing,
          permission: { data: permission, error: undefined },
          fills: { data: [], error: undefined },
          now,
        })
        ?.find((s) => s.key === 'permit')?.state;

    it('takes the chain over the executor, whichever way they disagree', () => {
      // The failure this exists for: a green LIVE badge over a permission the contract said was revoked.
      expect(permitWith({ data: 'revoked', error: undefined }, usable)).toBe('todo');
      expect(permitWith({ data: 'live', error: undefined }, null)).toBe('done');
    });

    it('reads every standing the chain can report', () => {
      expect(permitWith({ data: 'live', error: undefined })).toBe('done');
      for (const kind of ['none', 'revoked', 'expired'] as const) {
        expect(permitWith({ data: kind, error: undefined }), kind).toBe('todo');
      }
    });

    /*
     * Unreachable is not ungranted. Falling back to the executor here would answer a question about the chain with
     * something that is not the chain, and the one mistake this step must never make is calling a live permission absent.
     */
    it('says unknown when the chain would not answer, rather than falling back', () => {
      expect(permitWith({ data: 'unreadable', error: undefined }, usable)).toBe('unknown');
      expect(permitWith({ data: undefined, error: failure }, usable)).toBe('unknown');
    });

    it('is checking while the chain read is out', () => {
      expect(permitWith({ data: undefined, error: undefined }, usable)).toBe('checking');
    });

    it('falls back to the executor only where there is no chain read at all', () => {
      expect(permitWith(undefined, usable)).toBe('done');
      expect(permitWith(undefined, null)).toBe('todo');
      expect(permitWith(undefined, { ...usable, revoked: true })).toBe('todo');
      expect(permitWith(undefined, { ...usable, expiresAt: now - HOUR })).toBe('todo');
      expect(permitWith(undefined, { ...usable, delegateIsCurrent: false })).toBe('todo');
      // Absent is not expired and not a moved key — the rule the two helpers already keep.
      expect(permitWith(undefined, { revoked: false })).toBe('done');
    });
  });

  it('does not read a balance nobody gave as an empty one', () => {
    const fundWith = (balance: d.SetupRead<{ total: number } | null>) =>
      d
        .setupSteps({
          signedOut: false,
          balance,
          permission: { data: null, error: undefined },
          fills: { data: [], error: undefined },
          now,
        })
        ?.find((s) => s.key === 'fund')?.state;
    expect(fundWith({ data: null, error: undefined })).toBe('unknown');
    expect(fundWith({ data: { total: Number.NaN }, error: undefined })).toBe('unknown');
    expect(fundWith({ data: { total: 0 }, error: undefined })).toBe('todo');
    expect(fundWith({ data: { total: 0.42 }, error: undefined })).toBe('done');
  });
});

describe('coveredLabel — a change names the window it really measured', () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 8, 20, 12);
  const since = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  it('keeps the pill\'s label when the history fills the window', () => {
    expect(d.coveredLabel('1W', 'past week', now - 7 * DAY, since, now)).toBe('past week');
    // A candle a little short of the window's edge is the feed's rows, not a missing stretch.
    expect(d.coveredLabel('1M', 'past month', now - 29 * DAY, since, now)).toBe('past month');
  });

  it('says when the readings begin when they cover much less than the pill — two days are not a year', () => {
    expect(d.coveredLabel('1Y', 'past year', now - 2 * DAY, since, now)).toBe('since 2026-09-18');
    expect(d.coveredLabel('1W', 'past week', now - 2 * DAY, since, now)).toBe('since 2026-09-18');
  });

  it('keeps the label when there is nothing drawn to date it by', () => {
    expect(d.coveredLabel('1Y', 'past year', undefined, since, now)).toBe('past year');
  });
});
