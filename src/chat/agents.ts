/**
 * The four agents you can be talking to, and what each is good for.
 *
 * `ask({ agentId, ... })` has always taken a persona id and the chat has always sent one — it just
 * sent whichever agent happened to own the current proposal, or fell back to Momentum Scout. So
 * four distinct voices existed server-side, each with its own mandate and its own refusals, and
 * there was no way to reach three of them.
 *
 * The ids are the server's persona ids (`server/src/bot/personas.ts`) and the names match
 * `agentGradients`, so an agent's colour, its orb and the id in the request all come from one row.
 *
 * Openers are QUESTIONS, never claims. "What are you watching?" costs nothing if the model has
 * nothing to say; a starter that asserted a position or a number would be putting words in the
 * agent's mouth before it had spoken.
 *
 * Agents someone makes (2026-09-16) join them here, from the executor's roster (`useMadeAgents`): each speaks in the
 * voice of the one of the four it works like, under its own name and mandate.
 */
import { useMemo } from 'react';
import type { Href } from 'expo-router';
import { create } from 'zustand';
import type { Agent } from '@/data/types';

/** A screen that already shows part of an agent's work from real records. */
export type Shortcut = {
  label: string;
  href: Href;
};

export type ChatAgent = {
  /** The persona id the server knows; for an agent someone made, its own roster id. */
  id: string;
  /** Matches a key in `agentGradients`, so the colour follows the agent. */
  name: string;
  /** Its mandate, in the server's own words — or, for one someone made, in theirs. */
  role: string;
  /**
   * For an agent someone made: the persona id of the one of the four it works like, which is the voice the server asks.
   * Absent on the four themselves.
   */
  persona?: string;
  /** Three things worth asking THIS agent, as opposed to any of them. */
  openers: readonly string[];
  /**
   * Where its work can be seen without asking, for a build with no language model to answer a question.
   *
   * Offered in the openers' place when the executor says nothing can reply (`voice.ts`): its own page, the record its
   * mandate reads, and every run. Each opens a screen that shows it; none is a line written for the chat.
   */
  shortcuts: readonly Shortcut[];
};

export const CHAT_AGENTS: readonly ChatAgent[] = [
  {
    id: 'momentum-scout',
    name: 'Momentum Scout',
    role: 'Rides breakouts on liquid majors',
    openers: [
      'What are you watching right now',
      'Why did you skip today',
      'What would make you take a position',
    ],
    shortcuts: [
      { label: 'How it trades', href: '/agent/momentum-scout' },
      { label: 'Today’s movers', href: '/movers' },
      { label: 'All runs', href: '/runs' },
    ],
  },
  {
    id: 'earnings-desk',
    name: 'Earnings Desk',
    role: 'Trades tokenized equity earnings',
    openers: [
      'What is on the calendar',
      'Why avoid trading into a print',
      'How do you size around earnings',
    ],
    shortcuts: [
      { label: 'How it trades', href: '/agent/earnings-desk' },
      { label: 'Earnings dates', href: '/earnings' },
      { label: 'All runs', href: '/runs' },
    ],
  },
  {
    id: 'yield-keeper',
    name: 'Yield Keeper',
    role: 'Moves idle cash into the best rate',
    openers: [
      'Where is idle cash earning most',
      'When would you move it',
      'What is the risk in supplying',
    ],
    shortcuts: [
      { label: 'How it trades', href: '/agent/yield-keeper' },
      { label: 'What cash earns', href: '/rates' },
      { label: 'All runs', href: '/runs' },
    ],
  },
  {
    id: 'drawdown-guard',
    name: 'Drawdown Guard',
    role: 'Cuts risk when the book bleeds',
    openers: [
      'When would you cut',
      'What are you watching for',
      'How do you decide what to sell first',
    ],
    shortcuts: [
      { label: 'How it trades', href: '/agent/drawdown-guard' },
      { label: 'Agent limits', href: '/risk' },
      { label: 'All runs', href: '/runs' },
    ],
  },
] as const;

export const DEFAULT_AGENT: ChatAgent = CHAT_AGENTS[0]!;

/**
 * An agent someone made, as the chat talks to it: its own name, mandate and page, and the voice, questions and screens
 * of the one of the four it works like. `undefined` for the four themselves, which are `CHAT_AGENTS`.
 */
export function chatAgentOf(agent: Agent): ChatAgent | undefined {
  if (!agent.custom) return undefined;
  const like = CHAT_AGENTS.find((a) => a.id === agent.style) ?? DEFAULT_AGENT;
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role || like.role,
    persona: like.id,
    openers: like.openers,
    shortcuts: [{ label: 'How it trades', href: `/agent/${agent.id}` }, ...like.shortcuts.slice(1)],
  };
}

type MadeAgents = {
  /** The agents this wallet made, in the order the executor lists them. */
  made: readonly ChatAgent[];
  /** Takes them from a roster the executor gave; the same roster read again changes nothing. */
  remember: (roster: readonly Agent[]) => void;
  /** One just made, before the roster is read again. */
  add: (agent: Agent) => void;
};

const sameAgents = (a: readonly ChatAgent[], b: readonly ChatAgent[]) =>
  a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.name === b[i]!.name && x.role === b[i]!.role);

export const useMadeAgents = create<MadeAgents>((set, get) => ({
  made: [],
  remember: (roster) => {
    const made = roster.flatMap((a) => chatAgentOf(a) ?? []);
    if (!sameAgents(made, get().made)) set({ made });
  },
  add: (agent) => {
    const made = chatAgentOf(agent);
    if (!made) return;
    set((s) => ({ made: [...s.made.filter((a) => a.id !== made.id), made] }));
  },
}));

/** The four, then the agents this wallet made. */
export function useChatAgents(): readonly ChatAgent[] {
  const made = useMadeAgents((s) => s.made);
  return useMemo(() => [...CHAT_AGENTS, ...made], [made]);
}

/** The agent behind a name the thread recorded, for attributing an old message. */
export function agentByName(name: string): ChatAgent {
  return (
    CHAT_AGENTS.find((a) => a.name === name) ??
    useMadeAgents.getState().made.find((a) => a.name === name) ??
    DEFAULT_AGENT
  );
}
