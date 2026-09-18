/**
 * The chat's rooms: black, and light.
 *
 * Everything else in the app is true black (`src/ui/tokens.ts`). The conversation was drawn from the reference chosen
 * for it — a lavender ground, white message cards, glass controls and one iridescent orb — and Messages now also comes in
 * black, the app's own ground, with the same glass, the same accent and the same orbs (2026-09-16). Which one shows is a
 * preference on the device (`chatTheme.ts`); black unless light was chosen.
 *
 * Each room is its own palette rather than overrides scattered through the screens, so a room can be read — and changed —
 * in one place. `chat` is the palette in use: the drawer swaps it in place when the theme changes (`applyChatTheme`) and
 * redraws what it holds, so every `chat.x` read while drawing follows it. Nothing reads it at import time.
 *
 * Green and red keep their one meaning in both — profit and loss, a fill and a stop — deepened against white, lifted
 * against black.
 */
import { familyFor } from '@/ui';

export type ChatThemeName = 'black' | 'light';

const light = {
  groundTop: '#F6F4FD',
  groundMid: '#EEEBF9',
  groundBottom: '#E4E0F3',
  heading: '#3B2E52',
  /** What is written on `heading` when it is a fill — the initial in your avatar. */
  onHeading: '#FFFFFF',
  ink: '#2D2540',
  inkSoft: '#524868',
  muted: '#8A839E',
  faint: '#ABA4BF',
  card: 'rgba(255,255,255,0.94)',
  cardBorder: '#FFFFFF',
  glass: 'rgba(255,255,255,0.58)',
  glassBorder: 'rgba(255,255,255,0.9)',
  tile: '#F2EFFA',
  toolActive: 'rgba(134,112,224,0.14)',
  accentDeep: '#6A56C8',
  primaryTop: '#B7A5F6',
  primaryBottom: '#8670E0',
  handle: 'rgba(59,46,82,0.18)',
  /** The rule between rows in the Messages list. */
  hairline: 'rgba(59,46,82,0.08)',
  brandGreen: '#19C97A',
  up: '#17935C',
  down: '#D23E4B',
};

export type ChatPalette = { [K in keyof typeof light]: string };

/** The app's black, with the light room's accent: white words on it still read, and so does it on black. */
const black: ChatPalette = {
  groundTop: '#0E0D12',
  groundMid: '#08080B',
  groundBottom: '#000000',
  heading: '#F5F3FA',
  onHeading: '#15131B',
  ink: '#F2F0F7',
  inkSoft: '#C6C1D3',
  muted: '#8D889B',
  faint: '#5E596B',
  card: '#17161D',
  cardBorder: 'rgba(255,255,255,0.07)',
  glass: 'rgba(255,255,255,0.08)',
  glassBorder: 'rgba(255,255,255,0.12)',
  tile: '#1E1C25',
  toolActive: 'rgba(134,112,224,0.22)',
  accentDeep: '#8670E0',
  primaryTop: '#B7A5F6',
  primaryBottom: '#8670E0',
  handle: 'rgba(255,255,255,0.22)',
  hairline: 'rgba(255,255,255,0.08)',
  brandGreen: '#19C97A',
  up: '#2FD08A',
  down: '#FF5A67',
};

const SHADOWS: Record<ChatThemeName, readonly [string, string]> = {
  /** A lavender shadow, never a grey one: on the light ground a black shadow reads as dirt. */
  light: ['0 6px 18px rgba(92, 72, 160, 0.09)', '0 14px 34px rgba(92, 72, 160, 0.14)'],
  /** On black a shadow is depth, not colour. */
  black: ['0 6px 18px rgba(0, 0, 0, 0.45)', '0 14px 34px rgba(0, 0, 0, 0.6)'],
};

const ROOMS: Readonly<Record<ChatThemeName, ChatPalette>> = { light, black };

/**
 * A room's ground, by name, without putting that room in place.
 *
 * The cross-fade needs the palette it is LEAVING while the one it has arrived at is already in `chat`, and `chat` holds
 * exactly one at a time. This is the only way to read a room that is not the one being drawn.
 */
export function groundOf(theme: ChatThemeName): readonly [string, string, string] {
  const room = ROOMS[theme];
  return [room.groundTop, room.groundMid, room.groundBottom];
}

/** The palette in use. Read while drawing, never at import: it changes in place with the theme. */
export const chat: ChatPalette = { ...black };
export let chatShadow = SHADOWS.black[0];
export let chatShadowLg = SHADOWS.black[1];

/** Puts a room's palette in `chat`. The drawer calls it as it draws, before anything inside reads a colour. */
export function applyChatTheme(theme: ChatThemeName): void {
  Object.assign(chat, ROOMS[theme]);
  [chatShadow, chatShadowLg] = SHADOWS[theme];
}

export const chatType = Object.freeze({
  heading: { fontFamily: familyFor(600), fontSize: 29, lineHeight: 35, letterSpacing: -0.5 },
  subtitle: { fontFamily: familyFor(500), fontSize: 13, lineHeight: 19 },
  title: { fontFamily: familyFor(600), fontSize: 16, lineHeight: 21 },
  rowTitle: { fontFamily: familyFor(600), fontSize: 14.5, lineHeight: 19 },
  message: { fontFamily: familyFor(400), fontSize: 14, lineHeight: 20 },
  input: { fontFamily: familyFor(400), fontSize: 15, lineHeight: 21 },
  body: { fontFamily: familyFor(400), fontSize: 13.5, lineHeight: 19 },
  chip: { fontFamily: familyFor(500), fontSize: 13, lineHeight: 17 },
  small: { fontFamily: familyFor(500), fontSize: 11.5, lineHeight: 15 },
  label: { fontFamily: familyFor(700), fontSize: 11, lineHeight: 14, letterSpacing: 0.8 },
  button: { fontFamily: familyFor(600), fontSize: 14.5, lineHeight: 18 },
  value: { fontFamily: familyFor(700), fontSize: 14.5, lineHeight: 19 },
  action: { fontFamily: familyFor(700), fontSize: 22, lineHeight: 27, letterSpacing: -0.3 },
});
