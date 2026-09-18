/**
 * One agent's conversation — thread, proposal card and composer.
 *
 * Opened from the Messages list, in the drawer that slides up from the bottom (`ChatSheet`). Each agent has its own
 * conversation, as a messenger has one per person: the thread is one record, and `conversationOf` keeps this agent's part
 * of it. The header says who you are talking to, with the way back to the list and the way to close the drawer. One
 * conversation component for every agent: two copies of an approve-before-execute flow would be two places for the
 * expiry, the decline path and the fallback-is-not-an-answer rule to drift apart.
 *
 * It is drawn as its own light room: a lavender ground, a glass orb and "What Can I Do For You Today?"
 * while nothing has been said, then the conversation as a messenger draws one — the agent's words in white
 * cards on the left beside its orb, yours on the right in the room's accent — above a glass composer. The
 * trading screens stay true black; this is where you talk to the agents, and it looks like a different
 * place on purpose.
 *
 * What is not decoration is the proposal card. It keeps real Approve and Skip buttons and a real
 * countdown, because it is the one message in the thread that spends money.
 *
 * A build with no language model cannot answer a question, so it does not offer one (`voice.ts`): the suggestions become
 * the agent's own screens, which show its work from real records, and a question typed anyway is told why nothing answers.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import type { Href } from 'expo-router';
import { agentGradient } from '@/design/gradients';
import { Press, Text, duration, space, timing, useReducedMotion } from '@/ui';
import { mmss } from '@/format';
import { repos } from '@/data';
import { executorSentence, renderSegments, voice, type ThreadMessage } from '@/bot/message';
import { ApiError, apiReason } from '@/data/apiError';
import {
  botProse,
  decisionMessage,
  expiredMessage,
  useThread,
  userMessage,
  withDividers,
} from '@/bot/thread';
import { useTone } from '@/bot/tone';
import type { Proposal, ProposalDecision } from '@/data/types';
import { AgentPicker } from './AgentPicker';
import { Composer } from './Composer';
import { GlassOrb } from './GlassOrb';
import { Thinking } from './Thinking';
import { XorrMark } from './XorrMark';
import type { ChatAgent } from './agents';
import { conversationOf } from './conversations';
import { AgentAvatar, GLASS, GlassButton } from './parts';
import { chat, chatShadow, chatType } from './theme';
import { useDictation } from './useDictation';
import { useVoice } from './voice';

/** Thread gutter. */
const THREAD_PAD_H = space.s16;
/** An agent's orb beside its words. */
const AVATAR = 30;
/** Wide enough to read; short enough that the free edge still says who spoke. */
const USER_MAX = '78%' as const;
const BOT_MAX = '82%' as const;
/** The hero orb's ceiling: the room's centrepiece, never so large it crowds the composer. */
const ORB_MAX = 250;
const DECIDE_H = 44;
/** What an agent says to a question when this build has no language model to write its reply. */
const NO_MODEL_REPLY = 'I cannot answer that here: this build has no language model.';

/** A message card. The proposal card is the same card with more in it. Built as it draws, so it follows the theme. */
const card = () => ({
  backgroundColor: chat.card,
  borderRadius: 18,
  borderWidth: 1,
  borderColor: chat.cardBorder,
  paddingHorizontal: space.s14,
  paddingVertical: space.s10,
  boxShadow: chatShadow,
});

/** Your words: the room's accent, on the right, the corner nearest you squared off as a messenger draws it. */
const yours = () => ({
  backgroundColor: chat.accentDeep,
  borderRadius: 18,
  borderBottomRightRadius: 6,
  paddingHorizontal: space.s14,
  paddingVertical: space.s10,
  boxShadow: chatShadow,
});

export interface ChatProps {
  /** Who this conversation is with. */
  agent: ChatAgent;
  /** Back to the list of conversations. */
  onBack?: () => void;
  /** Renders a close control in the header — the drawer's way down, beside its handle and the dimmed screen. */
  onClose?: () => void;
  /** The roster, opened from the composer or the agent's orb, moves to another agent's conversation. */
  onSwitchAgent?: (agent: ChatAgent) => void;
  /**
   * Opens a screen from the conversation: the agent's page, the record its work reads. The drawer goes down for it and
   * comes back up here when that screen closes (`useChatDrawer.leave`).
   */
  onOpenScreen?: (href: Href) => void;
  /** Extra top padding. The sheet puts its drag handle above the header. */
  headerTop?: number;
  /**
   * Space under the composer.
   *
   * The drawer has no `Screen` around it, so it passes the home-indicator inset — without it the composer
   * sat on the home indicator, which on a device with a gesture bar means the send button and the
   * swipe-up gesture share the same 20 points.
   */
  footerInset?: number;
}

export function Chat({
  agent,
  onBack,
  onClose,
  onSwitchAgent,
  onOpenScreen,
  headerTop = 0,
  footerInset = 0,
}: ChatProps) {
  const scroller = useRef<ScrollView>(null);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  /** A decision is on its way to the executor. */
  const [deciding, setDeciding] = useState(false);
  /** The roster, opened from the composer. */
  const [agentsOpen, setAgentsOpen] = useState(false);
  /**
   * Suggested questions. `null` follows the thread — shown while nothing has been said — and a boolean
   * is the person's own choice from the sparkle button, until the next thing they ask.
   */
  const [startersChoice, setStartersChoice] = useState<boolean | null>(null);
  const { tone } = useTone();
  const messages = useThread((s) => s.messages);
  const proposal = useThread((s) => s.proposal);
  const decided = useThread((s) => s.decided);
  const hydrated = useThread((s) => s.hydrated);
  const hydrate = useThread((s) => s.hydrate);
  const append = useThread((s) => s.append);
  const setDecided = useThread((s) => s.setDecided);
  const markReadFor = useThread((s) => s.markReadFor);
  const voiceConfigured = useVoice((s) => s.configured);
  const readVoice = useVoice((s) => s.read);
  const voiceRefused = useVoice((s) => s.refused);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    void readVoice();
  }, [readVoice]);

  const agentName = agent.name;
  const accent = agentGradient(agentName).c1;
  const conversation = useMemo(() => conversationOf(messages, agentName), [messages, agentName]);
  const items = useMemo(() => withDividers(conversation), [conversation]);

  /* An open conversation is a read one: what the agent has said, and whatever it says while you are here. */
  useEffect(() => {
    if (hydrated) markReadFor(agentName);
  }, [hydrated, markReadFor, agentName, conversation.length]);

  /*
   * When the room's question gives way to the conversation.
   *
   * Not "when the conversation has anything in it": an agent that declines to propose says why as the drawer opens, so the
   * room would never be seen. The conversation starts when you say something, or when there is something to act on or
   * read back: a proposal, a fill, a receipt. Until then the agent's latest line is the subtitle.
   */
  const inProgress = thinking || conversation.some((m) => m.type !== 'prose');
  const latestLine = latestProse(conversation);
  const startersOpen = !thinking && (startersChoice ?? !inProgress);
  const dictation = useDictation(setDraft);
  const { listening, stop: stopListening } = dictation;
  const liveProposal = proposal && proposal.agent === agentName && !decided ? proposal : null;
  /*
   * Nothing in this build can write a reply, so a question has no one to answer it and the suggestions are the agent's
   * screens instead. Only once the executor has said so: not knowing yet offers the questions, as it always did.
   */
  const mute = voiceConfigured === false;
  const shortcuts = mute && onOpenScreen ? agent.shortcuts : null;

  /*
   * `override` is what lets a suggested question send itself. Routing it through `setDraft` and a
   * second tap would make the chips a way to fill in the box rather than a way to ask.
   */
  const send = useCallback(
    (override?: string) => {
      const text = (override ?? draft).trim();
      if (!text || thinking) return;
      if (listening) stopListening();
      append(userMessage(text, agentName));
      setDraft('');
      setStartersChoice(null);
      setAgentsOpen(false);
      setThinking(true);
      // PLAN.md 11.7: a real question to the real agent. The reply is PROSE ONLY — anything
      // numeric is rejected server-side before it can reach this thread.
      void repos.bot
        .ask({
          agentId: agent.persona ?? agent.id,
          question: text,
          tone,
          ...(agent.persona ? { as: { name: agent.name, role: agent.role } } : {}),
        })
        /*
         * A fallback line is not an answer, and must not be dressed as one.
         *
         * `ask` returns `{ text, source }` and this used only `text`. With no language model
         * configured the server answers `source: 'none'` with no text at all, so asking
         * "why did the CBBTC buy fail?" got back "Nothing worth chasing today. Ranges are thin and
         * the tape is quiet." — a confident non-sequitur in the agent's own voice, which is exactly
         * the canned-content-as-real-output this project refuses everywhere else.
         *
         * The reply still arrives; it just says what it is, and why (`unanswered`).
         */
        .then((reply) => {
          // Told by the reply itself, so an executor too old to publish it on /health still gets the screens offered.
          if (reply.reason === 'no_key') voiceRefused();
          append(
            botProse(agentName, [
              voice(reply.source === 'model' && reply.text ? reply.text : unanswered(reply)),
            ]),
          );
        })
        .catch(() =>
          append(
            botProse(agentName, [voice('I could not answer that just now, so I will not guess.')]),
          ),
        )
        .finally(() => setThinking(false));
    },
    [draft, thinking, listening, stopListening, append, agent, agentName, tone, voiceRefused],
  );

  return (
    <View style={{ flex: 1 }}>
      <LinearGradient
        colors={[chat.groundTop, chat.groundMid, chat.groundBottom]}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />

      {/*
        A hairline under the header: a thread scrolled back was cut off right against the agent's name, and with no rule
        between them the cut line read as the conversation sliding under the header.
      */}
      <View
        style={{
          paddingTop: headerTop,
          paddingBottom: space.s10,
          paddingHorizontal: space.gutter,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.s10,
          minHeight: GLASS,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: chat.hairline,
        }}
      >
        {onBack ? <GlassButton icon="back" label="All messages" onPress={onBack} /> : null}
        {/* Who is listening — and, where there is a roster to open, the way to talk to someone else. */}
        <Press
          onPress={onSwitchAgent ? () => setAgentsOpen((open) => !open) : undefined}
          disabled={!onSwitchAgent}
          accessibilityRole={onSwitchAgent ? 'button' : 'image'}
          accessibilityLabel={onSwitchAgent ? `${agentName}. Talk to another agent` : agentName}
          hitWidth={44}
          hitHeight={44}
        >
          <AgentAvatar name={agentName} size={GLASS} />
        </Press>
        <View style={{ flex: 1 }}>
          <Text color={chat.heading} style={chatType.title} numberOfLines={1}>
            {agentName}
          </Text>
          <Text color={chat.muted} style={chatType.small} numberOfLines={1}>
            {liveProposal ? liveProposal.status : agent.role}
          </Text>
        </View>
        {onClose ? <GlassButton icon="close" label="Close messages" onPress={onClose} /> : null}
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1, minHeight: 0 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={20}
      >
        <ScrollView
          ref={scroller}
          // Clipped at its own top edge: scrolled back, the thread slid under the header's controls.
          style={{ flex: 1, overflow: 'hidden' }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => {
            if (inProgress) scroller.current?.scrollToEnd({ animated: false });
          }}
          contentContainerStyle={{
            flexGrow: 1,
            paddingTop: space.s18,
            paddingBottom: space.s12,
            paddingHorizontal: THREAD_PAD_H,
            gap: space.s14,
          }}
        >
          {inProgress ? (
            items.map((item, i) =>
              'divider' in item ? (
                <Text key={`d${i}`} color={chat.faint} align="center" style={chatType.small}>
                  {item.divider}
                </Text>
              ) : item.type === 'proposal' ? (
                proposal && item.proposalId === proposal.id ? (
                  <ProposalCard
                    key={item.id}
                    proposal={proposal}
                    decided={decided}
                    busy={deciding}
                    onDecide={async (d) => {
                      /*
                       * Decided once the executor has answered, and shown as what it answered.
                       *
                       * This marked the card decided before the request left, then drew a green fill
                       * for any approve at all — so a refused order, a failed swap and a request that
                       * never landed all looked like a trade. PLAN.md 1.3.
                       */
                      if (!proposal || deciding) return;
                      setDeciding(true);
                      /*
                       * Only the request's own failure is said as one, and only a refusal the executor sent says nothing was
                       * decided. The answer's rendering sat inside this try, so a fill whose sentence carried a number threw in
                       * `voice()` and was reported as "did not reach the executor, so nothing was decided" about an order that
                       * had filled (Android emulator, 2026-09-15). A request that timed out or lost its connection may still
                       * have been decided and placed, so that is said as not known.
                       */
                      let res: ProposalDecision;
                      try {
                        res = await repos.bot.decideProposal(proposal.id, d);
                      } catch (e) {
                        const refused = e instanceof ApiError && e.status < 500;
                        const why = apiReason(e);
                        append(
                          botProse(
                            agentName,
                            executorSentence(
                              refused
                                ? `${why ? why.replace(/[.\s]*$/, '.') : 'The executor refused that.'} Nothing was decided, so you can try again.`
                                : 'I could not hear back from the executor, so I do not know whether this was placed. Check All runs before you try again.',
                              'executor:decide',
                            ),
                          ),
                        );
                        setDeciding(false);
                        return;
                      }
                      try {
                        setDecided(d);
                        append(decisionMessage(agentName, res));
                      } finally {
                        setDeciding(false);
                      }
                    }}
                    onExpire={() => {
                      if (decided || deciding) return;
                      setDecided('skip');
                      append(expiredMessage());
                    }}
                  />
                ) : (
                  // A card whose proposal is no longer the open one: what it offered is not held here, so it is not redrawn.
                  <Text key={item.id} color={chat.faint} align="center" style={chatType.small}>
                    An earlier proposal, now closed.
                  </Text>
                )
              ) : (
                <Turn key={item.id} message={item} />
              ),
            )
          ) : (
            <Hero agent={agent} line={latestLine} mute={mute} />
          )}

          {/* Where the answer is about to land, not in the header above it. */}
          {thinking ? <ThinkingTurn agentName={agentName} accent={accent} /> : null}
        </ScrollView>

        {agentsOpen && onSwitchAgent ? (
          <View style={{ paddingHorizontal: THREAD_PAD_H, paddingBottom: space.s8 }}>
            <AgentPicker
              selected={agent}
              onSelect={(a) => {
                setAgentsOpen(false);
                setStartersChoice(null);
                if (a.id !== agent.id) onSwitchAgent(a);
              }}
            />
          </View>
        ) : null}

        {/*
          Suggested questions for this agent. They are QUESTIONS: a starter that asserted a position or a
          number would put words in the agent's mouth before it had said anything, which on this product is
          the one thing a convenience must not do.

          With no language model they are the agent's screens instead, because a question there has no one to answer it.
        */}
        {startersOpen ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            style={{ flexGrow: 0 }}
            contentContainerStyle={{
              gap: space.s8,
              paddingHorizontal: THREAD_PAD_H,
              paddingBottom: space.s8,
            }}
          >
            {shortcuts
              ? shortcuts.map((s) => (
                  <Chip
                    key={s.label}
                    label={s.label}
                    accessibilityLabel={`Open ${s.label}`}
                    onPress={() => onOpenScreen?.(s.href)}
                  />
                ))
              : agent.openers.map((q) => (
                  <Chip key={q} label={q} accessibilityLabel={`Ask: ${q}`} onPress={() => send(q)} />
                ))}
          </ScrollView>
        ) : null}

        <Composer
          draft={draft}
          onChangeDraft={setDraft}
          onSend={() => send()}
          busy={thinking}
          agentName={agentName}
          agentsOpen={agentsOpen}
          onToggleAgents={() => setAgentsOpen((open) => !open)}
          startersOpen={startersOpen}
          onToggleStarters={() => setStartersChoice(!startersOpen)}
          dictation={dictation}
          footerInset={footerInset}
        />
      </KeyboardAvoidingView>
    </View>
  );
}

/** A suggestion under the thread: a question to ask or, with no model to answer one, a screen to open. */
function Chip({
  label,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Press
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={{
        borderRadius: 18,
        paddingHorizontal: space.s14,
        paddingVertical: space.s8,
        backgroundColor: chat.glass,
        borderWidth: 1,
        borderColor: chat.glassBorder,
      }}
    >
      <Text color={chat.inkSoft} style={chatType.chip}>
        {label}
      </Text>
    </Press>
  );
}

/**
 * The room before anything has been said: the agent's latest line — or who is listening, or that nothing here can reply —
 * the question the room asks, and the orb, lit in the agent's colour so each conversation has its own light.
 */
function Hero({ agent, line, mute }: { agent: ChatAgent; line?: string; mute: boolean }) {
  const { width, height } = useWindowDimensions();
  const orb = Math.round(Math.min(ORB_MAX, width * 0.62, height * 0.3));

  return (
    <View style={{ flex: 1, alignItems: 'center', paddingTop: space.s10 }}>
      <Text color={chat.muted} align="center" style={[chatType.subtitle, { maxWidth: 290 }]}>
        {line ??
          (mute
            ? `${agent.name} can’t reply here yet: this build has no language model.`
            : `Just type your question — ${agent.name} ${lowerFirst(agent.role)}.`)}
      </Text>
      <Text color={chat.heading} align="center" style={[chatType.heading, { marginTop: space.s12 }]}>
        {'What Can I Do For\nYou Today?'}
      </Text>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: space.s18 }}>
        <GlassOrb size={orb} tint={accentOf(agent)} />
      </View>
    </View>
  );
}

const accentOf = (agent: ChatAgent) => agentGradient(agent.name).c1;

function lowerFirst(s: string): string {
  return s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/** The agent's most recent plain line — the room's subtitle until the conversation starts. */
function latestProse(messages: readonly ThreadMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type === 'prose') return renderSegments(m.segments);
  }
  return undefined;
}

/**
 * What the agent says when no model wrote its reply, by why not. None of these is an answer, and none is dressed as one.
 *
 * It said "no language model is configured in this build" for all three, including a request that never reached the
 * server and a model that answered with something the voice gate refused.
 */
function unanswered(reply: { text: string | null; reason?: string }): string {
  if (reply.reason === 'no_key') return NO_MODEL_REPLY;
  // The request never arrived, and the data layer says so in its own words.
  if (reply.reason === 'unreachable' && reply.text) return reply.text;
  return 'I could not answer that just now, so I will not guess.';
}

/**
 * One turn in the conversation, drawn as a messenger draws one: the agent's words on the left beside its orb, yours on the
 * right in the room's accent.
 *
 * Every turn was a white card on the right — the agent's with its orb beside it, yours without — so a conversation read
 * as one column of cards and who said what came down to an orb. With one agent per conversation its name is the header's,
 * so no turn repeats it; a system line, an expiry, carries xorr's mark instead of the orb.
 */
function Turn({ message }: { message: ThreadMessage }) {
  const reduced = useReducedMotion();
  const scale = useSharedValue(message.type === 'fill' ? 0.96 : 1);

  useEffect(() => {
    // animations.md "If you add motion" #2: a single 250ms scale-in on the filled-order
    // card, once, on arrival. Nothing else in the thread animates.
    if (message.type === 'fill') {
      scale.value = withTiming(1, timing(duration.slow, reduced));
    }
  }, [message.type, reduced, scale]);

  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  if (message.type === 'user') {
    return (
      <View style={[yours(), { alignSelf: 'flex-end', maxWidth: USER_MAX }]}>
        <Text color="#FFFFFF" style={chatType.message}>
          {message.text}
        </Text>
      </View>
    );
  }

  const segments = 'segments' in message ? message.segments : [];
  /*
   * A fill is green and a decline is red because both are outcomes with a direction. Everything else
   * the agent says is ordinary prose and takes ordinary ink — colouring a whole side of the conversation
   * would spend the P&L palette on tone of voice.
   */
  const color =
    message.type === 'fill' ? chat.up : message.type === 'declined' ? chat.down : chat.ink;
  const who = 'agent' in message ? message.agent : undefined;

  return (
    <Animated.View style={[{ alignSelf: 'stretch' }, anim]}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.s8 }}>
        {who ? <AgentAvatar name={who} size={AVATAR} /> : <XorrMark size={AVATAR} />}
        <View style={[card(), { flexShrink: 1, maxWidth: BOT_MAX, borderBottomLeftRadius: 6 }]}>
          <Text color={color} style={chatType.message}>
            {renderSegments(segments)}
          </Text>
        </View>
      </View>
    </Animated.View>
  );
}

/** The agent working: its three dots in a card beside its orb, where the answer will land. */
function ThinkingTurn({ agentName, accent }: { agentName: string; accent: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.s8 }}>
      <AgentAvatar name={agentName} size={AVATAR} />
      <View style={[card(), { paddingVertical: space.s14, borderBottomLeftRadius: 6 }]}>
        <Thinking color={accent} />
      </View>
    </View>
  );
}

function ProposalCard({
  proposal,
  decided,
  busy,
  onDecide,
  onExpire,
}: {
  proposal: Proposal | null;
  decided: null | 'approve' | 'skip';
  /** A decision is in flight: no second tap, which would be a second order request. */
  busy: boolean;
  onDecide: (d: 'approve' | 'skip') => void;
  onExpire: () => void;
}) {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!proposal) return;
    const tick = () => {
      const left = Math.max(0, Math.round((proposal.expiresAt - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) onExpire();
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [proposal, onExpire]);

  if (!proposal) return null;
  const expired = remaining === 0;
  const locked = expired || busy;

  return (
    <View style={[card(), { borderRadius: 22, padding: space.s16 }]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text color={chat.accentDeep} style={chatType.label}>
          PROPOSED TRADE
        </Text>
        <Text color={expired ? chat.down : chat.muted} style={chatType.small}>
          {expired ? 'expired' : `expires ${mmss(remaining)}`}
        </Text>
      </View>

      <View
        style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.s8, marginTop: space.s10 }}
      >
        <Text color={chat.ink} style={chatType.action}>
          {proposal.action}
        </Text>
        <Text color={chat.muted} style={chatType.body}>
          {proposal.notional}
        </Text>
      </View>

      <View style={{ flexDirection: 'row', gap: space.s8, marginTop: space.s12 }}>
        <Stat label="Entry" value={proposal.entry} />
        <Stat label="Stop" value={proposal.stop} color={chat.down} />
        <Stat label="Target" value={proposal.target} color={chat.up} />
      </View>

      <Text color={chat.muted} style={[chatType.body, { marginTop: space.s12 }]}>
        {proposal.rationale}
      </Text>

      {decided ? null : (
        // design.md §5's decision row: the secondary at flex 1, the primary at 1.3.
        <View style={{ flexDirection: 'row', gap: space.s10, marginTop: space.s14 }}>
          <Press
            accessibilityRole="button"
            accessibilityLabel="Skip this trade"
            accessibilityState={{ disabled: locked }}
            disabled={locked}
            onPress={() => onDecide('skip')}
            style={{
              flex: 1,
              height: DECIDE_H,
              borderRadius: DECIDE_H / 2,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: chat.tile,
              opacity: locked ? 0.5 : 1,
            }}
          >
            <Text color={chat.inkSoft} style={chatType.button}>
              Skip
            </Text>
          </Press>
          <Press
            accessibilityRole="button"
            accessibilityLabel="Approve this trade"
            accessibilityState={{ disabled: locked }}
            disabled={locked}
            onPress={() => onDecide('approve')}
            style={{
              flex: 1.3,
              height: DECIDE_H,
              borderRadius: DECIDE_H / 2,
              overflow: 'hidden',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: locked ? 0.5 : 1,
            }}
          >
            <LinearGradient
              colors={[chat.primaryTop, chat.primaryBottom]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            {/* Above the gradient: on web an absolute layer paints over its in-flow siblings. */}
            <View style={{ zIndex: 1 }}>
              <Text color="#FFFFFF" style={chatType.button}>
                Approve
              </Text>
            </View>
          </Press>
        </View>
      )}
    </View>
  );
}

/** One of the card's three figures, on a tile a step darker than the card. */
function Stat({ label, value, color = chat.ink }: { label: string; value: string; color?: string }) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: chat.tile,
        borderRadius: 14,
        paddingHorizontal: space.s10,
        paddingVertical: space.s8,
      }}
    >
      <Text color={chat.muted} style={chatType.small}>
        {label}
      </Text>
      <Text color={color} style={[chatType.value, { marginTop: space.s2 }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}
