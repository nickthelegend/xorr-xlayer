/**
 * How much risk the agent may take.
 *
 * Every threshold the autonomous agent reasons with — how big an entry, how far into a move before
 * it counts as one, how close to a scheduled split it will go, how long it waits between trades —
 * used to be a constant nobody outside the code could see or change. They are not implementation
 * details: they are the whole of what "careful" or "aggressive" means, and they belong to the
 * person whose money it is.
 *
 * The numbers shown are the ones the server sent, never a copy held here. A screen with its own
 * table would drift from the agent the first time a threshold moved, and the drift would appear as
 * this screen confidently describing behaviour the agent no longer has.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  BackButton,
  Button,
  ErrorState,
  Fill,
  LoadingRows,
  NoteStrip,
  RadioCard,
  Row,
  Screen,
  Text,
  colors,
  size,
  space,
} from '@/ui';
import { api } from '@/data/api';
import { errorText } from '@/data/apiError';
import { useAsync } from '@/data/useAsync';
import {
  PROFILE_TITLE,
  differences,
  settingLines,
  type RiskProfile,
  type RiskProfileState,
} from '@/bot/risk';

export default function AgentRisk() {
  const goBack = useGoBack();
  const read = useAsync(() => api.get<RiskProfileState>('/agents/risk-profile'), []);
  const state = read.data;

  const [picked, setPicked] = useState<RiskProfile>();
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();

  const active = state?.active;
  // Nothing is "chosen" until it differs from what is already in force.
  const choice = picked && picked !== active ? picked : undefined;
  const activeOption = state?.options.find((o) => o.profile === active);
  const choiceOption = state?.options.find((o) => o.profile === choice);
  const changes =
    activeOption && choiceOption ? differences(activeOption.settings, choiceOption.settings) : [];

  async function save(profile: RiskProfile) {
    setSaving(true);
    setFailure(undefined);
    try {
      await api.post('/agents/risk-profile', { profile });
      // Re-read rather than assume: the server decides what is in force, and it just told us.
      await read.reload();
      setPicked(undefined);
    } catch (e) {
      /*
       * On the screen, not in a console. A setting that silently fails to save is the worst kind
       * here — the user walks away believing the agent is careful and it is not.
       */
      setFailure(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen gutter="none" sheet>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.s8,
          paddingHorizontal: space.gutter,
        }}
      >
        <BackButton onPress={() => goBack()} />
        <Text variant="screenTitle">Agent risk</Text>
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        {read.error ? (
          <ErrorState error={read.error} onRetry={read.reload} />
        ) : !state ? (
          <LoadingRows count={4} height={size.rowLg} />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30 }}
          >
            <Text variant="secondary" color={colors.ink55} style={{ marginBottom: space.s16 }}>
              This changes what the agent will actually take, not how it describes itself.
            </Text>

            <View style={{ gap: space.s10 }}>
              {state.options.map((o) => (
                <RadioCard
                  key={o.profile}
                  title={PROFILE_TITLE[o.profile]}
                  detail={o.blurb}
                  tag={o.profile === active ? 'In force' : undefined}
                  selected={(picked ?? active) === o.profile}
                  onPress={() => setPicked(o.profile)}
                />
              ))}
            </View>

            {/*
              What would change, and only what would change.

              Eight rows where six are identical makes the reader do the comparison this screen
              exists to do for them, and buries the two that matter.
            */}
            {choice && changes.length > 0 ? (
              <View style={{ marginTop: space.s20 }}>
                <Text variant="cardTitle" style={{ marginBottom: space.s8 }}>
                  What changes
                </Text>
                {changes.map((d, i) => (
                  <Row
                    key={d.label}
                    title={d.label}
                    value={`${d.before} → ${d.after}`}
                    height={size.rowLg}
                    divider={i < changes.length - 1}
                  />
                ))}
              </View>
            ) : activeOption ? (
              /* Otherwise the full set for what is in force, so the current behaviour is readable. */
              <View style={{ marginTop: space.s20 }}>
                <Text variant="cardTitle" style={{ marginBottom: space.s8 }}>
                  In force now
                </Text>
                {settingLines(activeOption.settings).map((line, i, all) => (
                  <Row
                    key={line.label}
                    title={line.label}
                    value={line.value}
                    height={size.rowLg}
                    divider={i < all.length - 1}
                  />
                ))}
              </View>
            ) : null}

            {failure ? (
              <NoteStrip kind="blocked" style={{ marginTop: space.s14 }}>
                {`That did not save, so the agent is still on ${PROFILE_TITLE[state.active]}. ${failure}`}
              </NoteStrip>
            ) : null}

            {/*
              Only open positions are unaffected, and saying so matters: somebody moving to
              Conservative because they are nervous should know this does not close anything.
            */}
            {choice ? (
              <>
                <Text
                  variant="footnote"
                  color={colors.ink55}
                  style={{ marginTop: space.s14 }}
                >
                  This applies to what the agent opens next. Positions you already hold keep the
                  exits they were given.
                </Text>
                <Button
                  label={`Switch to ${PROFILE_TITLE[choice]}`}
                  loading={saving}
                  onPress={() => void save(choice)}
                  style={{ marginTop: space.s12 }}
                />
              </>
            ) : null}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
