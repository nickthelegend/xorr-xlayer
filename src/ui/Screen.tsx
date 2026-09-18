/**
 * Screen.tsx — the screen shell.
 *
 * design.md §4 specifies `padding: 54px 0 26px` (22px with a tab bar) on a 402×874 canvas.
 * Those are the numbers for one device. Here they come from the real safe-area insets:
 *
 *   top    = insets.top + 10          the 10 is the "breathing room" half of the 54
 *   bottom = insets.bottom, floored   26 without a tab bar, 22 with one — a device that
 *                                     reports no inset still gets the design's padding
 *
 * With a tab bar, `Screen` yields the bottom padding entirely to `TabBar`, which sits
 * flush to the edge and pads itself. Two components padding the same edge is how you get
 * a 40px gap under a tab bar.
 *
 * Layout law (design.md §4): the *content* region takes `flex: 1`, never a trailing
 * spacer. An empty flex:1 view above a footer collects all the leftover height and opens
 * a visible hole. `Screen` gives `flex: 1` to nothing on its own — compose a `<Fill />`
 * onto the chart, the list or the scroll area.
 *
 * A tap on the background puts the keyboard away. That is not a nicety on iOS: a **number pad
 * has no return key**, so on any screen whose primary button sits in the footer — sign-in's
 * six-digit code, the send amount, a grid's bounds — the keypad covers the only control that
 * would accept what was just typed, and without this there is no way to move it. Caught by
 * driving the real app on a simulator; it is invisible on web, where the keyboard is hardware.
 */
import React from 'react';
import { Keyboard, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, space } from './tokens';

/** The breathing room design.md folds into its 54px top padding. */
const TOP_BREATHING_ROOM = space.s10;

/** The grabber at the top of a sheet — the reference video's notch, as a plain handle. */
const GRABBER_W = 36;
const GRABBER_H = 5;

export interface ScreenProps {
  children?: React.ReactNode;
  /**
   * Horizontal padding. `gutter` (20) for a normal screen, `sheet` (16) where a card runs
   * to the edge and its own padding makes up the difference, `none` where rows must bleed.
   */
  gutter?: 'gutter' | 'sheet' | 'none';
  /** A `TabBar` is rendered inside this screen, so it owns the bottom inset. */
  tabBar?: boolean;
  /** The light sheet (Auto Close, order ticket). Everything else is true black. */
  light?: boolean;
  /**
   * Presented as an iOS sheet (`presentation: 'modal'`) rather than pushed.
   *
   * A sheet already starts below the status bar, and the safe-area insets come from the window, not
   * the sheet — so the usual top padding opened an empty band the height of the status bar inside
   * it. On iOS a sheet gets a grabber and a small margin instead. Android presents full-screen, so
   * there the status bar still needs its inset.
   */
  sheet?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Screen({
  children,
  gutter = 'gutter',
  tabBar = false,
  light = false,
  sheet = false,
  style,
  testID,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const asSheet = sheet && Platform.OS === 'ios';

  const paddingHorizontal =
    gutter === 'none' ? 0 : gutter === 'sheet' ? space.sheetGutter : space.gutter;

  return (
    <View
      testID={testID}
      /*
       * Responder negotiation runs deepest-first, so this is only asked about a touch that no
       * control underneath claimed — a tap on the background. Returning false declines the
       * responder, so nothing else about touch handling changes.
       */
      onStartShouldSetResponder={() => {
        Keyboard.dismiss();
        return false;
      }}
      style={[
        {
          flex: 1,
          backgroundColor: light ? colors.sheet.bg : colors.bg,
          paddingTop: asSheet ? space.s8 : insets.top + TOP_BREATHING_ROOM,
          paddingBottom: tabBar ? 0 : Math.max(insets.bottom, space.s26),
          paddingHorizontal,
        },
        style,
      ]}
    >
      {asSheet ? (
        <View
          style={{
            alignSelf: 'center',
            width: GRABBER_W,
            height: GRABBER_H,
            borderRadius: GRABBER_H / 2,
            backgroundColor: light ? colors.sheet.tick : colors.ink28,
            marginBottom: space.s8,
          }}
        />
      ) : null}
      {children}
    </View>
  );
}

/**
 * The flex:1 region. Put it on the thing that should absorb the leftover height — the
 * chart, the list, the scroll area — never on an empty view above a footer.
 */
export function Fill({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[{ flex: 1, minHeight: 0 }, style]}>{children}</View>;
}
