/**
 * The two pieces the Messages list and a conversation share: an agent's orb, and the glass circle every control in the
 * light room sits in.
 */
import React from 'react';
import { View } from 'react-native';
import { Icon, type IconName } from '@/design/Icon';
import { agentGradient } from '@/design/gradients';
import { AssetMark, Press } from '@/ui';
import { chat, chatShadow } from './theme';

/** The glass controls' diameter, and their touch target. */
export const GLASS = 40;
const HIT = 44;

/** An agent's orb — its gradient with a glass highlight, ringed in white so it sits on the room's ground. */
export function AgentAvatar({ name, size = 30 }: { name: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 2,
        borderColor: chat.cardBorder,
        overflow: 'hidden',
        boxShadow: chatShadow,
      }}
    >
      <AssetMark gradient={agentGradient(name)} size={size - 4} />
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: size * 0.14,
          left: size * 0.18,
          width: size * 0.36,
          height: size * 0.2,
          borderRadius: size / 2,
          backgroundColor: '#FFFFFF',
          opacity: 0.5,
          transform: [{ rotate: '-30deg' }],
        }}
      />
    </View>
  );
}

/** A control in the light room: a glyph in a glass circle, with a full-size target. */
export function GlassButton({
  icon,
  label,
  onPress,
  size = GLASS,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  size?: number;
}) {
  return (
    <Press
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitWidth={HIT}
      hitHeight={HIT}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: chat.glass,
        borderWidth: 1,
        borderColor: chat.glassBorder,
      }}
    >
      <Icon name={icon} size={17} color={chat.inkSoft} strokeWidth={2.1} />
    </Press>
  );
}
