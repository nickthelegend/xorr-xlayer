/**
 * Which room Messages is drawn in: black, like the rest of the app, or the light lavender one.
 *
 * Kept on the device, as a display preference is (`PLAN.md 3.11`), in its own small store so the app's store does not
 * carry a chat setting.
 *
 * ## Following the phone (FEATURES.md #35)
 *
 * It used to be black unless someone had chosen light, on the reading that everything outside the drawer is true black
 * and a light room rising over it is the one bright surface in the app. That reading is still right about the *app*; it
 * was wrong about the *person*. Someone whose phone is in light mode has already answered which room they want to read
 * in, in the one place the whole OS asks. Opening at black over that is this app choosing for them, having been told.
 *
 * So `chosen` is a three-state answer and `null` — nothing chosen here — is the default: follow the phone. The sun/moon
 * button is still an outright choice and, once made, outranks the phone forever, because the person who taps it is
 * answering about this room specifically. Nobody who has already tapped it is moved: a stored value only exists because
 * `pick` wrote one.
 *
 * `useChatRoom` is what a component asks; nothing reads `chosen` to draw with.
 */
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { otherRoom, roomToShow } from './room';
import type { ChatThemeName } from './theme';

type ChatTheme = {
  /** The room this person asked for here, or null to follow the phone. */
  chosen: ChatThemeName | null;
  /** Choose the room that is not showing. An explicit choice, and it stays. */
  pick: (showing: ChatThemeName) => void;
};

export const useChatTheme = create<ChatTheme>()(
  persist(
    (set) => ({
      chosen: null,
      pick: (showing) => set({ chosen: otherRoom(showing) }),
    }),
    {
      name: 'xorr-chat-theme',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ chosen: s.chosen }),
    },
  ),
);

/**
 * The room to draw, and whether the phone is deciding it.
 *
 * `useColorScheme` re-renders on its own when the phone's appearance changes — including the automatic switch at dusk —
 * so a drawer left open follows it, and `RoomFade` makes that a dissolve rather than a flash.
 */
export function useChatRoom(): { room: ChatThemeName; following: boolean } {
  const chosen = useChatTheme((s) => s.chosen);
  const scheme = useColorScheme();
  return { room: roomToShow(chosen, scheme), following: chosen === null };
}
