/**
 * Signed out — what a wallet screen shows before anyone has named a wallet.
 *
 * Fifty-odd screens said "That did not load. Not signed in, so /x was not requested. Try again" here: a failure for a
 * request nobody made, a path nobody needed to read, and a retry that could only fail the same way. Nothing went wrong,
 * so nothing is reported. There is one step that answers the screen, and this offers it.
 *
 * The one file in this layer that navigates, because signing in is the one place every screen sends someone.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { Button } from './Button';
import { Text } from './Text';
import { space } from './tokens';

/**
 * Where signing in starts: the email step itself.
 *
 * It opened the splash, so a person who pressed "Sign in" on any screen answered the onboarding questions again before
 * they could type their email. `returning` sends them Home once they are in, rather than on into funding.
 */
export function signIn(): void {
  router.push({ pathname: '/wallet', params: { returning: '1' } });
}

/** A line and a button, centred, in place of what the screen would show a signed-in wallet. */
export function SignInPrompt({ text = 'Sign in to see this.', testID }: { text?: string; testID?: string }) {
  return (
    <View testID={testID} style={{ paddingVertical: space.s30, gap: space.s16, alignItems: 'center' }}>
      <Text variant="rowPrimary" align="center">
        {text}
      </Text>
      <Button label="Sign in" onPress={signIn} testID="sign-in" />
    </View>
  );
}

/** A screen's primary action while nobody is signed in to take it: the same place, the one step that is possible. */
export function SignInButton({
  label = 'Sign in',
  height,
  backgroundColor,
  color,
  style,
}: {
  label?: string;
  height?: number;
  /** A ticket's own colours, so the action keeps its place and its look. */
  backgroundColor?: string;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Button
      label={label}
      onPress={signIn}
      height={height}
      backgroundColor={backgroundColor}
      color={color}
      style={style}
      testID="sign-in-action"
    />
  );
}
