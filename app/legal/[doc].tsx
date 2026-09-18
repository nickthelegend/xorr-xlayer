/**
 * Legal documents — PLAN.md 14.3 [G38].
 *
 * The app runs autonomous strategies against real capital; the in-screen footnotes are not
 * sufficient on their own. These are drafted to be honest and specific, and they are
 * explicitly NOT legal advice: task 14.2 still requires counsel on the non-custodial
 * posture before launch.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  BackButton,
  EmptyState,
  Fill,
  NoteStrip,
  Screen,
  Text,
  colors,
  space,
} from '@/ui';
import { LEGAL } from '@/legal/documents';

export default function LegalDoc() {
  const { doc } = useLocalSearchParams<{ doc: string }>();
  const goBack = useGoBack();
  /*
   * An unknown slug is not the Terms.
   *
   * This read `LEGAL[doc ?? 'terms'] ?? LEGAL.terms!`, so /legal/anything rendered the Terms under
   * the heading "Terms" and nothing said the requested document had not been found. For most
   * routes that fallback is a harmless convenience; for legal documents it means someone who
   * followed a stale or mistyped link to the risk disclosure reads the terms of service instead
   * and has no way to notice. Say the document does not exist and point at the ones that do.
   */
  const entry = doc ? LEGAL[doc] : undefined;

  if (!entry) {
    return (
      <Screen>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
          <BackButton onPress={() => goBack()} />
          <Text variant="screenTitle" numberOfLines={1} style={{ flex: 1 }}>
            Not found
          </Text>
        </View>
        <Fill style={{ marginTop: space.s18 }}>
          <EmptyState
            text={`There is no legal document called "${doc ?? ''}". The ones that exist are the terms, the privacy policy and the risk disclosure.`}
            actionLabel="Read the terms"
            onAction={() => router.replace('/legal/terms')}
          />
        </Fill>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
        <BackButton onPress={() => goBack()} />
        <Text variant="screenTitle" numberOfLines={1} style={{ flex: 1 }}>
          {entry.title}
        </Text>
      </View>

      <Fill style={{ marginTop: space.s18 }}>
        <ScrollView showsVerticalScrollIndicator={false}>
          <Text variant="footnote" color={colors.ink55}>
            {entry.updated}
          </Text>
          {entry.sections.map((s) => (
            <View key={s.heading} style={{ marginTop: space.s22, gap: space.s8 }}>
              <Text variant="cardTitle">{s.heading}</Text>
              {s.paragraphs.map((p, i) => (
                // Legal prose is read in long passes, so it takes a looser leading than the
                // body variant's 1.5 — the one place in the app that is the right call.
                <Text key={i} variant="body" color={colors.ink55} style={{ lineHeight: 14 * 1.6 }}>
                  {p}
                </Text>
              ))}
            </View>
          ))}
          <NoteStrip kind="risk" style={{ marginTop: space.s26, marginBottom: space.s30 }}>
            {entry.footer}
          </NoteStrip>
        </ScrollView>
      </Fill>
    </Screen>
  );
}
