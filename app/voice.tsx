/**
 * How the bot talks: three registers, each a name and a line.
 *
 * The tone control lives in Settings as three radio labels — "Dry", "Sharp", "Flat" — which asks
 * someone to pick a register from an adjective. This puts each one's line beside it.
 *
 * Not the instruction behind it. That text is written for a model — "Write plainly with dry
 * understatement…" — and it sat under every card, which put the prompt on the screen. A register is
 * chosen by what it sounds like, which the line says; the instruction stays with the executor
 * (server/src/bot/tone.ts), where it is used.
 *
 * What is NOT shown is a sample reply. Generating one per tone would mean four model calls to
 * illustrate a setting, and writing them by hand would put words in the agent's mouth that it never
 * said — the exact thing the voice rules exist to prevent.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  Fill,
  HeaderBar,
  Press,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  space,
} from '@/ui';
import { TONES, useTone } from '@/bot/tone';
import { useVoice } from '@/chat/voice';

export default function Voice() {
  const goBack = useGoBack();
  const { tone, setTone } = useTone();
  // With no language model nothing writes in any register yet (`src/chat/voice.ts`); the choice is kept for when one does.
  const mute = useVoice((s) => s.configured) === false;

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Voice</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          {mute ? 'How the bot will write to you, once this build has a language model.' : 'How the bot writes to you.'}
        </Text>
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: space.s30, gap: space.s10 }}
        >
          {TONES.map((t) => {
            const on = t.id === tone;
            return (
              <Press
                key={t.id}
                onPress={() => setTone(t.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${t.label}. ${t.description}`}
              >
                <SheetCard
                  bordered
                  borderRadius={radius.panel}
                  padding={space.s16}
                  style={on ? { borderColor: colors.ink30 } : undefined}
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                    }}
                  >
                    <Text variant="rowPrimaryLg" color={on ? colors.ink : colors.ink65}>
                      {t.label}
                    </Text>
                    {on ? (
                      <Text variant="control" color={colors.ink55}>
                        In use
                      </Text>
                    ) : null}
                  </View>

                  <Text variant="secondary" color={colors.ink65} style={{ marginTop: space.s8 }}>
                    {t.description}
                  </Text>
                </SheetCard>
              </Press>
            );
          })}

          <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
            {/*
              The rule that matters, in one line. Whatever the tone, every figure on screen is rendered
              by the app from its own records: the tone reaches the words, never a number.
            */}
            <Text variant="secondarySm" color={colors.ink55}>
              Tone never changes a number.
            </Text>
          </SheetCard>
        </ScrollView>
      </Fill>
    </Screen>
  );
}
