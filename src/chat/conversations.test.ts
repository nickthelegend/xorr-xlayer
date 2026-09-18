/**
 * One record, a conversation per agent: who said what, what is new, and when it moved — the Messages list, the tab bar's
 * count and each conversation read the thread through these, so they must agree.
 */
import { describe, expect, it } from 'vitest';
import { voice, type ThreadMessage } from '../bot/message';
import { attribute, conversationOf, listTime, preview, searchMessages, summaries, unreadTotal } from './conversations';

const at = (h: number, m = 0) => new Date(2026, 8, 15, h, m).getTime();

const said = (id: string, agent: string, text: string, when: number): ThreadMessage => ({
  id,
  at: when,
  author: 'bot',
  type: 'prose',
  agent,
  segments: [voice(text)],
});
const asked = (id: string, text: string, when: number, to?: string): ThreadMessage => ({
  id,
  at: when,
  author: 'user',
  type: 'user',
  text,
  ...(to ? { to } : {}),
});
const proposed = (id: string, when: number): ThreadMessage => ({ id, at: when, author: 'bot', type: 'proposal', proposalId: 'p1' });
const expired = (id: string, when: number): ThreadMessage => ({
  id,
  at: when,
  author: 'system',
  type: 'expired',
  segments: [voice('That proposal expired before you decided.')],
});

describe('who a message belongs to', () => {
  it('puts a question with the agent it was asked of, and an older one with the agent who answered', () => {
    const messages = [
      asked('q1', 'Where is idle cash earning most', at(9), 'Yield Keeper'),
      said('a1', 'Yield Keeper', 'The lending pool pays best today.', at(9, 1)),
      asked('q0', 'Why did you skip', at(10)),
      said('a0', 'Momentum Scout', 'Ranges were thin.', at(10, 1)),
    ];
    expect(attribute(messages)).toEqual(['Yield Keeper', 'Yield Keeper', 'Momentum Scout', 'Momentum Scout']);
  });

  it('puts a proposal with the agent who spoke beside it, and an expiry with the proposal it ended', () => {
    const messages = [said('o', 'Earnings Desk', 'A print is due.', at(11)), proposed('p', at(11, 1)), expired('e', at(11, 6))];
    expect(attribute(messages)).toEqual(['Earnings Desk', 'Earnings Desk', 'Earnings Desk']);
    expect(conversationOf(messages, 'Earnings Desk').map((m) => m.id)).toEqual(['o', 'p', 'e']);
    expect(conversationOf(messages, 'Momentum Scout')).toEqual([]);
  });

  it('leaves a message with no one around it without an owner', () => {
    expect(attribute([asked('q', 'Hello', at(8))])).toEqual([undefined]);
  });
});

describe('the list of conversations', () => {
  const agents = ['Momentum Scout', 'Earnings Desk', 'Yield Keeper', 'Drawdown Guard'];

  it('is every agent, the most recently active first and the quiet ones after in roster order', () => {
    const messages = [
      said('a', 'Yield Keeper', 'Rates moved.', at(9)),
      said('b', 'Momentum Scout', 'Watching the majors.', at(12)),
    ];
    const list = summaries(messages, agents, { since: 0, byAgent: {} });
    expect(list.map((s) => s.agent)).toEqual(['Momentum Scout', 'Yield Keeper', 'Earnings Desk', 'Drawdown Guard']);
    expect(list[0]!.last).toEqual({ text: 'Watching the majors.', at: at(12), fromYou: false });
    expect(list[2]!.last).toBeUndefined();
  });

  it('counts only the agent’s words said since its conversation was last open, and never yours', () => {
    const messages = [
      said('old', 'Momentum Scout', 'Earlier.', at(8)),
      asked('you', 'And now', at(9), 'Momentum Scout'),
      said('new', 'Momentum Scout', 'Now.', at(10)),
      said('other', 'Drawdown Guard', 'Cutting.', at(10)),
    ];
    const list = summaries(messages, agents, { since: at(7), byAgent: { 'Momentum Scout': at(8, 30) } });
    const unread = Object.fromEntries(list.map((s) => [s.agent, s.unread]));
    expect(unread).toEqual({ 'Momentum Scout': 1, 'Drawdown Guard': 1, 'Earnings Desk': 0, 'Yield Keeper': 0 });
    expect(unreadTotal(list)).toBe(2);
    // Everything before the device began keeping track counts as read.
    expect(unreadTotal(summaries(messages, agents, { since: at(11), byAgent: {} }))).toBe(0);
  });

  it('shows a proposal as what it is, not as an empty line', () => {
    expect(preview(proposed('p', at(9)))).toBe('Proposed a trade');
  });
});

describe('when a conversation last moved', () => {
  const now = at(15);

  it('says the time today, yesterday, the weekday this week, and the date before', () => {
    expect(listTime(at(8, 41), now)).toBe('8:41 AM');
    expect(listTime(new Date(2026, 8, 14, 22, 0).getTime(), now)).toBe('Yesterday');
    expect(listTime(new Date(2026, 8, 11, 9, 0).getTime(), now)).toBe('Friday');
    expect(listTime(new Date(2026, 8, 2, 9, 0).getTime(), now)).toBe('Sep 2');
    expect(listTime(new Date(2025, 11, 30, 9, 0).getTime(), now)).toBe('Dec 30, 2025');
  });
});

describe('searching what was said', () => {
  it('finds words in any conversation, newest first, whatever their case', () => {
    const messages = [
      said('a', 'Yield Keeper', 'The lending pool pays best.', at(9)),
      asked('b', 'Is the POOL safe', at(10), 'Yield Keeper'),
      said('c', 'Momentum Scout', 'Nothing to chase.', at(11)),
    ];
    expect(searchMessages(messages, 'pool').map((h) => h.id)).toEqual(['b', 'a']);
    expect(searchMessages(messages, '  ')).toEqual([]);
  });
});
