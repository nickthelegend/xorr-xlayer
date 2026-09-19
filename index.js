/**
 * The app entry.
 *
 * `main` used to point straight at `expo-router/entry`, which is correct on web and fatal on
 * native. Privy's Expo SDK runs JOSE and secp256k1 at import time, and React Native supplies
 * neither `global.crypto` nor `TextEncoder`. The first native build died on `Property 'crypto'
 * doesn't exist` before a single screen mounted — a failure the web bundle can never reproduce,
 * because on web the platform already provides both.
 *
 * The polyfills must come FIRST and must stay first: anything imported above them may capture a
 * global that does not exist yet. They are split by platform (`polyfills.native.js` /
 * `polyfills.web.js`) because a browser already has all of them, and loading the React Native
 * shims there announced itself in the console of every page.
 */
import './polyfills';

import 'expo-router/entry';
