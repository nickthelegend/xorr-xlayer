/**
 * The app entry.
 *
 * `main` used to point straight at `expo-router/entry`, which is correct on web and fatal on
 * native. Privy's Expo SDK runs JOSE and secp256k1 at import time, and React Native supplies
 * neither `global.crypto` nor `TextEncoder`. The first native build died on `Property 'crypto'
 * doesn't exist` before a single screen mounted — a failure the web bundle can never reproduce,
 * because on web the platform already provides both.
 *
 * These three imports must come FIRST and must stay first. `react-native-get-random-values`
 * installs `crypto.getRandomValues`, `fast-text-encoding` installs `TextEncoder`/`TextDecoder`,
 * and the ethers shims fill in the rest of what the signing path expects. Anything imported above
 * them may capture a global that does not exist yet.
 */
import 'react-native-get-random-values';
import 'fast-text-encoding';
import '@ethersproject/shims';

import 'expo-router/entry';
