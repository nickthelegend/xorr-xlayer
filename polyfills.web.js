/**
 * Nothing to install: a browser supplies `crypto.getRandomValues`, `TextEncoder` and the rest of what the signing
 * path expects. The native half (`polyfills.native.js`) explains why they are needed there and not here.
 */
export {};
