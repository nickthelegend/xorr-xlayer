/**
 * What React Native does not give the signing path, installed before anything can capture a global.
 *
 * Privy's Expo SDK runs JOSE and secp256k1 at import time, and React Native supplies neither `global.crypto` nor
 * `TextEncoder`: the first native build died on `Property 'crypto' doesn't exist` before a screen mounted. These
 * three must stay first, and they are imported from the entry (`index.js`) for that reason.
 *
 * The web half of this file is empty on purpose — a browser has all three already, and loading the shims there put
 * "Shims Injected: - nextTick" in the console of every page.
 */
import 'react-native-get-random-values';
import 'fast-text-encoding';
import '@ethersproject/shims';
