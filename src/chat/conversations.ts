/**
 * The thread as a messenger shows it: one conversation per agent, each with its last line, when it was said and whether
 * anything in it is new.
 *
 * Everything anyone said lives in one record (`src/bot/thread.ts`). An agent's words carry the agent, and a question
 * carries who it was asked of (`to`). Two kinds carry neither and are placed by what surrounds them: a proposal card and
 * an older question — asked before questions named their agent — belong to the agent who spoke next (the decision, the
 * answer), or failing that the one who spoke before; an expiry belongs to the agent whose proposal it ended. A message
 * with no one around it is left without an owner rather than handed one.
 *
 * Pure, so the list, the count on the tab bar and the conversation itself agree on who said what.
 */
import { renderSegments, type ThreadMessage } from '../bot/message';
import type { ReadState } from '../bot/thread';

export type ConversationSummary = {
  agent: string;
  /** The latest message in this agent's conversation, as one line. Absent when nothing has been said yet. */
  last?: { text: string; at: number; fromYou: boolean };
  /** The agent's messages since its conversation was last open. */
  unread: number;
};

export type SearchHit = { agent: string; id: string; text: string; at: number };

function ownAgent(m: ThreadMessage): string | undefined {
  if (m.type === 'user') return m.to;
  return 'agent' in m ? m.agent : undefined;
}

/**
 * Who each message belongs to, index for index.
 *
 * A message without its own agent takes the nearest one after it and, failing that, the nearest before it. An expiry
 * looks back first: it follows the proposal it ended.
 */
export function attribute(messages: readonly ThreadMessage[]): (string | undefined)[] {
  const own = messages.map(ownAgent);
  const after: (string | undefined)[] = new Array(messages.length);
  let next: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    after[i] = next;
    if (own[i]) next = own[i];
  }
  const out: (string | undefined)[] = [];
  let prev: string | undefined;
  messages.forEach((m, i) => {
    if (own[i]) {
      out.push(own[i]);
      prev = own[i];
    } else if (m.type === 'expired') {
      out.push(prev ?? after[i]);
    } else {
      out.push(after[i] ?? prev);
    }
  });
  return out;
}

/** One agent's conversation, in the order it was said. */
export function conversationOf(messages: readonly ThreadMessage[], agent: string): ThreadMessage[] {
  const owners = attribute(messages);
  return messages.filter((_, i) => owners[i] === agent);
}

/** A message as one line of the list. */
export function preview(m: ThreadMessage): string {
  switch (m.type) {
    case 'user':
      return m.text;
    case 'proposal':
      return 'Proposed a trade';
    default:
      return renderSegments(m.segments);
  }
}

/**
 * Every agent's conversation, the most recently active first. Agents with nothing said yet follow, in the order given,
 * so the list is the whole roster rather than only the agents someone has spoken to.
 */
export function summaries(
  messages: readonly ThreadMessage[],
  agents: readonly string[],
  read: ReadState,
): ConversationSummary[] {
  const owners = attribute(messages);
  const byAgent = new Map<string, ConversationSummary>(agents.map((a) => [a, { agent: a, unread: 0 }]));
  messages.forEach((m, i) => {
    const owner = owners[i];
    const summary = owner === undefined ? undefined : byAgent.get(owner);
    if (!summary || owner === undefined) return;
    summary.last = { text: preview(m), at: m.at, fromYou: m.author === 'user' };
    // Your own words are never news to you.
    const seen = Math.max(read.since, read.byAgent[owner] ?? 0);
    if (m.author !== 'user' && m.at > seen) summary.unread += 1;
  });
  const all = [...byAgent.values()];
  const active = all.filter((s) => s.last).sort((a, b) => b.last!.at - a.last!.at);
  return [...active, ...all.filter((s) => !s.last)];
}

/** Everything new across the agents — the count on the tab bar. */
export function unreadTotal(list: readonly ConversationSummary[]): number {
  return list.reduce((n, s) => n + s.unread, 0);
}

const DAY = 86_400_000;

/**
 * When a conversation last moved, the way a messenger says it: the time today, "Yesterday", the weekday within the week,
 * and the date before that — with the year only when it is not this one.
 */
export function listTime(at: number, now: number): string {
  if (!Number.isFinite(at)) return '';
  const d = new Date(at);
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= midnight) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (at >= midnight - DAY) return 'Yesterday';
  if (at >= midnight - 6 * DAY) return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** What was said that contains the words searched for, newest first, each with the agent it belongs to. */
export function searchMessages(messages: readonly ThreadMessage[], query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const owners = attribute(messages);
  const hits: SearchHit[] = [];
  messages.forEach((m, i) => {
    const agent = owners[i];
    if (agent === undefined) return;
    const text = preview(m);
    if (text.toLowerCase().includes(q)) hits.push({ agent, id: m.id, text, at: m.at });
  });
  return hits.reverse();
}
