/**
 * The composer — a glass card: the question on top, its tools underneath.
 *
 * Every control on it does something; this codebase closes dead controls rather than drawing them.
 *
 *   ×        clears what you typed — there only once there is something to clear, beside send (2026-09-16)
 *   bot      chooses which agent answers
 *   sparkle  shows questions worth asking this agent
 *   mic      dictates into the draft, only where the platform can hear (`useDictation`)
 *   send     asks — dim until there is something to ask
 */
import React from 'react';
import { Platform, StyleSheet, TextInput, View, type TextStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Icon, type IconName } from '@/design/Icon';
import { Press, Text } from '@/ui';
import { useChatRoom } from './chatTheme';
import { chat, chatShadowLg, chatType } from './theme';
import type { Dictation } from './useDictation';

const MIN_H = 48;
const MAX_H = 132;
const TOOL = 36;
const SEND = 36;
const HIT = 44;
const RADIUS = 26;

/** A browser draws its own focus ring inside the field; the card is the focus here. */
const NO_WEB_OUTLINE = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as TextStyle;

/**
 * Content above a painted layer.
 *
 * On web an absolutely positioned layer paints over its in-flow siblings whatever their order, so the
 * blur sat on top of the text and the send button's gradient on top of its arrow. A stacking level puts
 * them back where they are written.
 */
const ABOVE = { zIndex: 1 } as const;

export interface ComposerProps {
  draft: string;
  onChangeDraft: (text: string) => void;
  onSend: () => void;
  /** An answer is on its way: no second question until it lands. */
  busy: boolean;
  agentName: string;
  agentsOpen: boolean;
  onToggleAgents: () => void;
  startersOpen: boolean;
  onToggleStarters: () => void;
  dictation: Dictation;
  /** Space under the card — the sheet's home-indicator inset. */
  footerInset: number;
}

export function Composer({
  draft,
  onChangeDraft,
  onSend,
  busy,
  agentName,
  agentsOpen,
  onToggleAgents,
  startersOpen,
  onToggleStarters,
  dictation,
  footerInset,
}: ComposerProps) {
  const { room } = useChatRoom();
  const empty = draft.trim().length === 0;
  const canSend = !empty && !busy;

  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: footerInset }}>
      <View
        style={{
          borderRadius: RADIUS,
          borderWidth: 1,
          borderColor: chat.glassBorder,
          overflow: 'hidden',
          boxShadow: chatShadowLg,
        }}
      >
        {/* The blur takes the room's own tint: a light one over the black room drew the card grey. */}
        <BlurView intensity={40} tint={room === 'black' ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: chat.glass }]} />

        <View style={ABOVE}>
          <TextInput
            value={draft}
            onChangeText={onChangeDraft}
            placeholder="What are you looking for?"
            placeholderTextColor={chat.faint}
            accessibilityLabel={`Ask ${agentName}`}
            editable={!busy}
            multiline
            onSubmitEditing={() => {
              if (canSend) onSend();
            }}
            /*
             * Enter sends on web, where there is a hardware keyboard and a newline costs a modifier. On a
             * phone the return key on a multiline field inserts a newline — the send button is right there.
             */
            blurOnSubmit={Platform.OS === 'web'}
            returnKeyType="send"
            style={[
              chatType.input,
              {
                color: chat.ink,
                minHeight: MIN_H,
                maxHeight: MAX_H,
                paddingTop: 14,
                paddingBottom: 4,
                paddingHorizontal: 18,
              },
              NO_WEB_OUTLINE,
            ]}
          />

          {dictation.error ? (
            <Text color={chat.down} style={[chatType.small, { paddingHorizontal: 18, paddingBottom: 2 }]}>
              {dictation.error}
            </Text>
          ) : null}

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 8,
              paddingBottom: 8,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Tool
                name="bot"
                label={agentsOpen ? 'Close the list of agents' : 'Choose who answers'}
                active={agentsOpen}
                onPress={onToggleAgents}
              />
              <Tool
                name="sparkle"
                // "Suggestions", not "suggested questions": with no model to answer, they are the agent's screens.
                label={startersOpen ? 'Hide suggestions' : 'Show suggestions'}
                active={startersOpen}
                onPress={onToggleStarters}
                disabled={busy}
              />
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {/*
                Only with something to clear (2026-09-16). It sat first in the row, dimmed and dead whenever the box was
                empty — which is most of the time — and an × that does nothing reads as a close button that is broken.
                Here, beside send, it arrives with the draft without moving the tools on the left.
              */}
              {draft.length > 0 ? (
                <Tool name="close" label="Clear what you typed" onPress={() => onChangeDraft('')} disabled={busy} />
              ) : null}
              {dictation.supported ? (
                <Tool
                  name="mic"
                  label={dictation.listening ? 'Stop listening' : 'Speak your question'}
                  active={dictation.listening}
                  onPress={dictation.listening ? dictation.stop : () => dictation.start(draft)}
                  disabled={busy}
                />
              ) : null}
              {/* Without this the only way to send was the keyboard's return key, which is invisible to
                  anyone who has dismissed the keyboard. */}
              <Press
                accessibilityRole="button"
                accessibilityLabel="Send message"
                accessibilityState={{ disabled: !canSend }}
                disabled={!canSend}
                onPress={onSend}
                hitWidth={HIT}
                hitHeight={HIT}
                style={{
                  width: SEND,
                  height: SEND,
                  borderRadius: SEND / 2,
                  overflow: 'hidden',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: canSend ? 1 : 0.5,
                }}
              >
                <LinearGradient
                  colors={[chat.primaryTop, chat.primaryBottom]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <View style={ABOVE}>
                  <Icon name="send" size={16} color="#FFFFFF" strokeWidth={2.2} />
                </View>
              </Press>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

function Tool({
  name,
  label,
  onPress,
  disabled = false,
  active = false,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      onPress={onPress}
      hitWidth={HIT}
      hitHeight={HIT}
      style={{
        width: TOOL,
        height: TOOL,
        borderRadius: TOOL / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? chat.toolActive : 'transparent',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Icon name={name} size={19} color={active ? chat.accentDeep : chat.muted} />
    </Press>
  );
}
