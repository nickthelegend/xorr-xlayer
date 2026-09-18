/**
 * A screen's intent keys (`intentKey.ts`), made once and kept for as long as the screen is mounted.
 *
 * Per screen: the retry a key exists for is the same button tapped again after a timeout, and the sentence under that
 * timeout says to check Activity before trying again anywhere else.
 */
import { useState } from 'react';
import { intentKeys, type IntentKeys } from './intentKey';

export function useIntentKeys(): IntentKeys {
  // A lazy initial state, so the keys are made on the first render and never again.
  const [keys] = useState(intentKeys);
  return keys;
}
