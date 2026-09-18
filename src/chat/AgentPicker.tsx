/**
 * Who answers — the four agents, one tap apart.
 *
 * This was a rail of four orbs across the top of the thread. The room keeps its top for the question it
 * asks, so the roster opens from the composer's bot button instead, in place, just above where you type:
 * the same four agents, each with its mandate, the gradient that is its identity everywhere else in the
 * app, and choosing one closes it.
 */
import React from 'react';
import { View } from 'react-native';
import { AssetMark, Press, Text } from '@/ui';
import { Icon } from '@/design/Icon';
import { agentGradient } from '@/design/gradients';
import { useChatAgents, type ChatAgent } from './agents';
import { chat, chatShadowLg, chatType } from './theme';

const MARK = 32;

export function AgentPicker({
  selected,
  onSelect,
}: {
  selected: ChatAgent;
  onSelect: (agent: ChatAgent) => void;
}) {
  const agents = useChatAgents();
  return (
    <View
      style={{
        borderRadius: 22,
        padding: 6,
        backgroundColor: chat.card,
        borderWidth: 1,
        borderColor: chat.cardBorder,
        boxShadow: chatShadowLg,
      }}
    >
      {agents.map((a) => {
        const on = a.id === selected.id;
        return (
          <Press
            key={a.id}
            onPress={() => onSelect(a)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${a.name}. ${a.role}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 16,
              backgroundColor: on ? chat.tile : 'transparent',
            }}
          >
            <AssetMark gradient={agentGradient(a.name)} size={MARK} />
            <View style={{ flex: 1 }}>
              <Text color={chat.ink} style={chatType.rowTitle}>
                {a.name}
              </Text>
              <Text color={chat.muted} style={chatType.small}>
                {a.role}
              </Text>
            </View>
            {on ? <Icon name="check" size={16} color={chat.accentDeep} /> : null}
          </Press>
        );
      })}
    </View>
  );
}
