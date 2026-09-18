/**
 * Screen 3 — Agent intro sheet. screens.md Group C.
 *
 * Full-bleed surface card, radius 34, close top-right. 104pt orb, name, subtitle.
 * Three benefit blocks (22pt outline glyph — circle, rounded square, rotated square) gap 26.
 * White "Get Started". Footnote "All agents can make mistakes. Markets are risky."
 *
 * "Get Started" hires the agent, then opens the limits. It only opened the limits, so the one button
 * on an agent's introduction never made the agent yours — and it could be pressed before the roster
 * had answered, when there was no agent to start.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import Svg, { Circle, Rect } from 'react-native-svg';
import { agentGradient } from '@/design/gradients';
import {
  AgentOrb,
  Button,
  CloseButton,
  EmptyState,
  ErrorState,
  Fill,
  Placeholder,
  Screen,
  Text,
  colors,
  radius,
  size,
  space,
} from '@/ui';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { errorText } from '@/data/apiError';

const GLYPH = 22;
const STROKE = 1.8;

/*
 * What the product does, one line each.
 *
 * The middle block was "Never miss big moves · Tracks big price moves and key news, then triggers your
 * preset actions." Nothing a user can set up acts on news — the strategies that can be created act on
 * a schedule, a price or a position — so it described a feature that does not exist. What every run
 * does get is a record, refusals included. "Edit" left the last block for the same reason: strategies
 * can be paused and resumed here, not edited.
 */
const BENEFITS = [
  {
    glyph: 'circle',
    title: 'Runs for you 24/7',
    body: 'Your rules keep running while you are offline.',
  },
  {
    glyph: 'square',
    title: 'Every run on the record',
    body: 'Fills and refusals alike.',
  },
  {
    glyph: 'diamond',
    title: 'You are always in control',
    body: 'Pause anytime. It never trades outside your limits.',
  },
] as const;

export default function AgentIntro() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const goBack = useGoBack();
  const { data, loading, error, reload } = useAsync(() => repos.bot.listAgents(), []);
  // Either id: the roster links with `a.id`, which becomes a row uuid once the agent is hired.
  const agent = (data ?? []).find((a) => a.id === id || a.personaId === id);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string>();

  // A roster that could not be read is not a roster without this agent, so it is not "no such agent" either.
  if (!loading && error && !data) {
    return (
      <Screen style={{ backgroundColor: colors.surface, borderRadius: radius.sheetLg }}>
        <View style={{ alignItems: 'flex-end' }}>
          <CloseButton onPress={() => goBack()} />
        </View>
        <Fill>
          <ErrorState error={error} onRetry={reload} />
        </Fill>
      </Screen>
    );
  }

  /*
   * A roster miss ends the screen; it does not decorate it.
   *
   * The title and the role line were already fixed to stop naming a different agent, and the
   * comment below records why. Everything underneath them was left alone, so /bot/999/intro read
   * "No such agent — this agent is not on the roster", then showed Earnings Desk's orb gradient
   * (the same borrowed-identity bug, in colour), three paragraphs about what it would do for you,
   * and a "Get Started" button pointing at /bot/999/settings.
   *
   * There is nothing to get started with. Say so once and offer the roster.
   */
  if (!loading && !agent) {
    return (
      <Screen style={{ backgroundColor: colors.surface, borderRadius: radius.sheetLg }}>
        <View style={{ alignItems: 'flex-end' }}>
          <CloseButton onPress={() => goBack()} />
        </View>
        <Fill>
          <EmptyState
            text={`No agent "${id ?? ''}" on the roster.`}
            actionLabel="See the roster"
            onAction={() => router.replace('/bot/roster')}
          />
        </Fill>
      </Screen>
    );
  }

  async function start() {
    if (!agent) return;
    setStarting(true);
    setStartError(undefined);
    try {
      /*
       * Hired, then the limits.
       *
       * Hiring is idempotent on the server, but every call writes "Hired …" to the audit trail, so an
       * agent that is already yours is not hired a second time.
       */
      const hired = agent.hired ? agent : await repos.bot.hire(agent.personaId ?? agent.id);
      router.replace(`/bot/${hired.id}/settings`);
    } catch (e) {
      // The server's sentence, above the button that asked. Nothing was hired, so nothing moves on.
      setStartError(errorText(e));
      setStarting(false);
    }
  }

  return (
    // A sheet, not a screen: it sits on `surface` with the card radius, and the modal
    // presentation in `app/_layout.tsx` is what puts black behind it.
    <Screen style={{ backgroundColor: colors.surface, borderRadius: radius.sheetLg }}>
      <View style={{ alignItems: 'flex-end' }}>
        <CloseButton onPress={() => goBack()} />
      </View>

      <View style={{ alignItems: 'center', marginTop: space.s10, gap: space.s14 }}>
        {/*
          Nobody's colours while the roster is still answering. The orb fell back to Earnings Desk's
          gradient here, which is the borrowed identity the note above describes, drawn before any
          name had arrived.
        */}
        {agent ? (
          <AgentOrb
            gradient={agentGradient(agent.name)}
            identity={agent.name}
            size={size.orb104}
            face
            specular
            bloom
          />
        ) : (
          <Placeholder width={size.orb104} height={size.orb104} style={{ borderRadius: radius.full }} />
        )}
        <Text variant="onboardingTitle" align="center">
          {agent?.name ?? 'Loading…'}
        </Text>
        <Text variant="body" color={colors.ink55} align="center">
          {/* Not a different agent's description. These fell back to "Stocks Trader /
              Autonomous stock trading agent" whenever the id did not resolve, so a bad
              link introduced an agent that does not exist. */}
          {agent?.role ?? ''}
        </Text>
      </View>

      <Fill style={{ marginTop: space.s34, gap: space.s26 }}>
        {BENEFITS.map((b) => (
          <View key={b.title} style={{ flexDirection: 'row', gap: space.s14 }}>
            <BenefitGlyph kind={b.glyph} />
            <View style={{ flex: 1, gap: space.s6 }}>
              <Text variant="cardTitle">{b.title}</Text>
              <Text variant="secondary" color={colors.ink55}>
                {b.body}
              </Text>
            </View>
          </View>
        ))}
      </Fill>

      {startError ? (
        <Text
          variant="secondarySm"
          color={colors.down}
          align="center"
          style={{ marginBottom: space.s12 }}
        >
          {startError}
        </Text>
      ) : null}
      <Button label="Get Started" onPress={start} loading={starting} disabled={!agent} />
      <Text
        variant="footnote"
        color={colors.ink55}
        align="center"
        style={{ marginTop: space.s12 }}
      >
        All agents can make mistakes. Markets are risky.
      </Text>
    </Screen>
  );
}

function BenefitGlyph({ kind }: { kind: 'circle' | 'square' | 'diamond' }) {
  return (
    <Svg width={GLYPH} height={GLYPH} viewBox="0 0 24 24" style={{ marginTop: space.s2 }}>
      {kind === 'circle' ? (
        <Circle cx={12} cy={12} r={8.5} stroke={colors.ink55} strokeWidth={STROKE} fill="none" />
      ) : kind === 'square' ? (
        <Rect
          x={4}
          y={4}
          width={16}
          height={16}
          rx={5}
          stroke={colors.ink55}
          strokeWidth={STROKE}
          fill="none"
        />
      ) : (
        <Rect
          x={5}
          y={5}
          width={14}
          height={14}
          rx={3}
          stroke={colors.ink55}
          strokeWidth={STROKE}
          fill="none"
          transform="rotate(45 12 12)"
        />
      )}
    </Svg>
  );
}
