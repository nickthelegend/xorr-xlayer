/**
 * The app is a phone. On a wide browser, say so rather than stretching.
 *
 * Everything in `src/ui` is calibrated to `DESIGN_WIDTH` — 402pt. Let loose in a 1568px window the
 * layout does not break so much as become obviously wrong: a hero card a metre wide, a "Get
 * started" button spanning the whole screen, list rows whose value column is half a page from its
 * label. Nothing errors, and it reads immediately as a mobile build someone forgot to look at on a
 * laptop, which is the first thing anyone opening this on a desktop will see.
 *
 * So on web, above the design width, the app renders in a column of exactly that width, centred,
 * with the surrounding space filled in the app's own black. It is not a device mockup — no bezel,
 * no notch, no drop shadow pretending to be hardware. Just the layout at the size it was drawn for.
 *
 * Native is untouched: a phone IS this width, and wrapping there would add a view for nothing.
 *
 * It lives at the root rather than in `Screen` so the tab bar and the chat sheet are inside the
 * column too — both are `position: absolute` against their parent, and a `Screen`-level fix would
 * have left them spanning the full window while the content sat in the middle.
 */
import React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { DESIGN_WIDTH } from './responsive';
import { colors } from './tokens';

export function PhoneFrame({ children }: { children: React.ReactNode }) {
  const { width } = useWindowDimensions();

  /*
   * Read per render, not once: a browser window is resized, and a column that kept the width the
   * page loaded at would be the same bug in a different costume.
   */
  const constrain = Platform.OS === 'web' && width > DESIGN_WIDTH;
  if (!constrain) return <>{children}</>;

  return (
    <View style={{ flex: 1, alignItems: 'center', backgroundColor: colors.bg }}>
      {/*
        `overflow: hidden` so a sheet animating in from below is clipped to the column rather than
        sliding across the whole window, and `width` rather than `maxWidth` because the children
        measure themselves against a definite width.
      */}
      <View style={{ flex: 1, width: DESIGN_WIDTH, overflow: 'hidden', backgroundColor: colors.bg }}>
        {children}
      </View>
    </View>
  );
}
