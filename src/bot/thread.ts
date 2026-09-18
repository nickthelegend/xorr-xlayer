/**
 * Thread state — PLAN.md 6.2. The handoff designed screen 12 as a single-exchange snapshot [G43];
 * as the centre tab it needs a real thread: persistence, scrollback, unread state, and the
 * proposal's expiry actually expiring.
 *
 * One record of everything said, which `src/chat/conversations.ts` splits into a conversation per agent. What has been
 * read is kept per agent (`read`), so the Messages list can mark the agents with something new, as a messenger does.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { executorSentence, fact, voice, type Segment, type ThreadMessage } from './message';
import type { Proposal, ProposalDecision } from '../data/types';

const KEY = 'xorr-thread-v1';
/** When each agent's conversation was last open, and when this device began keeping track. */
const READ_KEY = 'xorr-thread-read-v1';
const PAGE = 30;

let seq = 0;
const nextId = () => `m${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * What has been read. `since` is when this device started keeping track: everything said before it counts as read, so an
 * old thread does not arrive as a wall of unread marks the first time the list is opened.
 */
export type ReadState = { since: number; byAgent: Record<string, number> };

export type ThreadStore = {
  messages: ThreadMessage[];
  proposal: Proposal | null;
  decided: null | 'approve' | 'skip';
  unread: number;
  read: ReadState;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  append: (m: ThreadMessage) => void;
  setProposal: (p: Proposal | null) => void;
  setDecided: (d: null | 'approve' | 'skip') => void;
  markRead: () => void;
  /** Everything one agent has said so far is read: its conversation is open. */
  markReadFor: (agent: string) => void;
  /** Oldest-first page for scrollback. */
  page: (n: number) => ThreadMessage[];
};

export const useThread = create<ThreadStore>((set, get) => ({
  messages: [],
  proposal: null,
  decided: null,
  unread: 0,
  read: { since: Date.now(), byAgent: {} },
  hydrated: false,

  async hydrate() {
    // The tab bar's count, the list and a conversation all ask; the thread is read from storage once.
    if (get().hydrated) return;
    try {
      const [raw, rawRead] = await Promise.all([AsyncStorage.getItem(KEY), AsyncStorage.getItem(READ_KEY)]);
      if (raw) set({ messages: JSON.parse(raw) as ThreadMessage[] });
      const saved = rawRead ? (JSON.parse(rawRead) as Partial<ReadState>) : undefined;
      if (saved && typeof saved.since === 'number') {
        set({ read: { since: saved.since, byAgent: saved.byAgent ?? {} } });
      } else {
        void AsyncStorage.setItem(READ_KEY, JSON.stringify(get().read)).catch(() => undefined);
      }
    } catch {
      // A corrupt thread must not brick the tab; start clean rather than crash.
    } finally {
      set({ hydrated: true });
    }
  },

  append(m) {
    set((s) => {
      const messages = [...s.messages, m];
      void AsyncStorage.setItem(KEY, JSON.stringify(messages.slice(-200))).catch(() => undefined);
      return { messages, unread: m.author === 'bot' ? s.unread + 1 : s.unread };
    });
  },

  setProposal: (proposal) => set({ proposal, decided: null }),
  setDecided: (decided) => set({ decided }),
  markRead: () => set({ unread: 0 }),
  markReadFor(agent) {
    set((s) => {
      const read = { since: s.read.since, byAgent: { ...s.read.byAgent, [agent]: Date.now() } };
      void AsyncStorage.setItem(READ_KEY, JSON.stringify(read)).catch(() => undefined);
      return { read };
    });
  },
  page: (n) => {
    const all = get().messages;
    return all.slice(Math.max(0, all.length - n * PAGE));
  },
}));

// ── Message builders. Every number goes through fact(); every quip through voice(). ──

export function botProse(agent: string, segments: Segment[]): ThreadMessage {
  return { id: nextId(), at: Date.now(), author: 'bot', type: 'prose', agent, segments };
}

/** A question, and the agent it was asked of — which is what puts it in that agent's conversation. */
export function userMessage(text: string, to?: string): ThreadMessage {
  return { id: nextId(), at: Date.now(), author: 'user', type: 'user', text, ...(to ? { to } : {}) };
}

/** A proposal card, with the agent that proposed it — which is whose conversation it sits in. */
export function proposalMessage(proposalId: string, agent?: string): ThreadMessage {
  return { id: nextId(), at: Date.now(), author: 'bot', type: 'proposal', proposalId, ...(agent ? { agent } : {}) };
}

/**
 * The thread's record of a decision, written from what the executor says it did.
 *
 * This file had a `fillMessage` composing "Filled. {units} SOL at {price}. Stop is set at {stop}." —
 * a fill template for an instrument this app cannot trade, which nothing called. The approve path
 * wrote its own version of that sentence for a trade that never happened. Now only a `filled` answer
 * becomes a fill, and every other outcome is shown as what it was. PLAN.md 1.3.
 */
export function decisionMessage(agent: string, d: ProposalDecision): ThreadMessage {
  const base = { id: nextId(), at: Date.now(), author: 'bot' as const, agent, segments: executorSentence(d.message, 'executor:decide') };
  switch (d.status) {
    case 'filled':
      return { ...base, type: 'fill' as const, outcome: 'filled' as const };
    case 'blocked':
    case 'failed':
      return { ...base, type: 'blocked' as const, reason: d.reason ?? d.status };
    case 'skip':
      return { ...base, type: 'declined' as const };
    case 'expired':
      return expiredMessage();
    default:
      return { ...base, type: 'prose' as const };
  }
}

export function expiredMessage(): ThreadMessage {
  return {
    id: nextId(),
    at: Date.now(),
    author: 'system',
    type: 'expired',
    segments: [voice('That proposal expired before you decided. I did not place it.')],
  };
}

export function dcaReceipt(
  agent: string,
  usd: number,
  units: number,
  symbol: string,
  signature?: string,
): ThreadMessage {
  return {
    id: nextId(),
    at: Date.now(),
    author: 'bot',
    type: 'dca-receipt',
    agent,
    signature,
    segments: [
      voice('Your recurring buy ran.'),
      fact(usd, 'money', 'schedule'),
      voice(`into ${symbol},`),
      fact(units, 'quantity', 'fill'),
      voice('filled.'),
    ],
  };
}

export function blockedMessage(agent: string, reason: string, segments: Segment[]): ThreadMessage {
  return { id: nextId(), at: Date.now(), author: 'bot', type: 'blocked', agent, reason, segments };
}

export function strategyCreated(agent: string, strategyId: string, segments: Segment[]): ThreadMessage {
  return {
    id: nextId(),
    at: Date.now(),
    author: 'bot',
    type: 'strategy-created',
    agent,
    strategyId,
    segments,
  };
}

/** Day dividers — screens.md shows a date divider at the head of the thread. */
export function dayKey(at: number): string {
  return new Date(at).toDateString();
}

export function withDividers(messages: ThreadMessage[]): (ThreadMessage | { divider: string })[] {
  const out: (ThreadMessage | { divider: string })[] = [];
  let last = '';
  for (const m of messages) {
    const k = dayKey(m.at);
    if (k !== last) {
      out.push({ divider: formatDivider(m.at) });
      last = k;
    }
    out.push(m);
  }
  return out;
}

function formatDivider(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
