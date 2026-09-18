/**
 * room.ts — which room Messages is drawn in, decided.
 *
 * The two questions behind `chatTheme.ts`, kept pure and apart from the store so they can be tested: what the phone's
 * appearance asks for, and what a tap on the sun/moon button chooses. Neither touches storage, and neither is a colour.
 */
import type { ChatThemeName } from './theme';

/**
 * What `useColorScheme()` can answer. Named here so this module needs nothing from react-native.
 *
 * `'unspecified'` is in react-native's own `ColorSchemeName` and is what a phone that has not been asked reports; it
 * lands with the rest of the silence below.
 */
export type Appearance = 'light' | 'dark' | 'unspecified' | null | undefined;

/**
 * The phone's appearance, as a room.
 *
 * Anything that is not `light` is the black room — a phone in dark mode, and a phone that will not say. Black is what
 * the rest of this app is, so it is the answer that needs no assumption; guessing light from silence would put the one
 * bright surface in the app in front of someone who never asked for it.
 */
export function roomForScheme(scheme: Appearance): ChatThemeName {
  return scheme === 'light' ? 'light' : 'black';
}

/**
 * The room to show, from what was chosen here and what the phone says.
 *
 * A choice made on this button outranks the phone, forever: the person who tapped it was answering about this room
 * specifically, and an app that quietly reverted them at dusk would be ignoring the more specific of two answers.
 */
export function roomToShow(chosen: ChatThemeName | null, scheme: Appearance): ChatThemeName {
  return chosen ?? roomForScheme(scheme);
}

/** What the sun/moon button picks: the room that is not showing, whatever decided the one that is. */
export function otherRoom(showing: ChatThemeName): ChatThemeName {
  return showing === 'black' ? 'light' : 'black';
}
