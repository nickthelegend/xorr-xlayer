/**
 * What the agents have to say as the drawer opens: an open proposal, or — when there is none — one asked for.
 *
 * It lived in the conversation, which the Messages list now sits in front of. A proposal waiting for an answer then only
 * reached the thread once some conversation was opened, and the list could not show which agent had asked for
 * something. The drawer asks as it opens, and the list, the count on the tab bar and the conversation read one thread.
 */
import { useEffect, useRef } from 'react';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { voice } from '@/bot/message';
import { botProse, proposalMessage, useThread } from '@/bot/thread';

/** Who the executor's decline speaks as: the proposal generator is Momentum Scout's. */
const DECLINE_VOICE = 'Momentum Scout';

export function useProposalSeed(): void {
  const hydrated = useThread((s) => s.hydrated);
  const hydrate = useThread((s) => s.hydrate);
  const messages = useThread((s) => s.messages);
  const append = useThread((s) => s.append);
  const setProposal = useThread((s) => s.setProposal);

  // Ask for an open proposal; if there is none, ask the agent to CONSIDER one. Without this
  // the approve-before-execute pipeline had no producer and the thread was permanently empty.
  const { data } = useAsync(async () => {
    const open = await repos.bot.currentProposal();
    if (open) return { proposal: open, declined: undefined as string | undefined };
    return repos.bot.generateProposal();
  }, []);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Seed the thread once, from whatever the agent actually decided.
  //
  // The `seeded` ref only guards one mount, and the thread is persisted — so every fresh
  // load appended the same proposal again and the chat showed it two, three, four times.
  // The real guard is the thread's own contents: a proposal already in the thread is
  // already seeded.
  const seeded = useRef(false);
  useEffect(() => {
    if (!hydrated || !data || seeded.current) return;
    seeded.current = true;

    if (data.proposal) {
      const already = messages.some((m) => m.type === 'proposal' && m.proposalId === data.proposal!.id);
      setProposal(data.proposal);
      if (already) return;
      /*
       * The opening line is spoken only when a model wrote one.
       *
       * It used to fall back to the persona's pre-written sentence, which reads as the agent's
       * take on THIS setup and is not. The proposal card carries the size, the entry, the
       * stop, the target and the cap it fits inside — all computed from real prices — so the
       * absence costs the user a sentence, never a fact.
       */
      if (data.proposal.opening) append(botProse(data.proposal.agent, [voice(data.proposal.opening)]));
      // The card names its agent itself, so it lands in that agent's conversation without a line written for it.
      append(proposalMessage(data.proposal.id, data.proposal.agent));
      return;
    }
    /*
     * A decline is a message, not a blank screen. "What it chose not to do" is the product.
     *
     * Guarded on the thread's contents, the same way the proposal above is: every fresh mount
     * appended another identical line, and "No live market for WETH" stacked up four deep in a
     * thread whose whole claim is that it is a record of what happened.
     */
    if (data.declined) {
      const line = stripNumbers(data.declined);
      const said = messages.some(
        (m) => m.type === 'prose' && m.segments.some((seg) => seg.kind === 'voice' && seg.text === line),
      );
      if (!said) append(botProse(DECLINE_VOICE, [voice(line)]));
    }
  }, [hydrated, data, messages, append, setProposal]);
}

/**
 * The server's decline reasons name a symbol but sometimes a figure too. A voice segment may
 * not carry a number (src/bot/message.ts), so any digits are dropped rather than the message.
 */
function stripNumbers(text: string): string {
  const cleaned = text.replace(/[$]?[\d,.]+%?/g, '').replace(/\s{2,}/g, ' ').trim();
  return cleaned.length > 4 ? cleaned : 'There is nothing worth proposing right now.';
}
