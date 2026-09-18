/**
 * Type/entry shim. Metro resolves `.web.ts` on web and `.native.ts` on iOS/Android BEFORE this
 * file, so at runtime this is never used — it exists so TypeScript and every screen can import
 * `@/auth/useAuth` without knowing which Privy SDK is underneath.
 */
export * from './useAuth.native';
