import { describe, expect, it } from 'vitest';
import { agentKey } from './agentKey.js';

describe('agentKey', () => {
  /*
   * The owner sets a budget under the key the APP derives (`src/wallet/agentBudget.ts`), and this charges trades to the
   * key the executor derives. The same fixed vector is asserted there, so the two cannot drift apart unnoticed.
   */
  it('is keccak256 of "xorr-agent:" and the agent id', () => {
    expect(agentKey('agent-1')).toBe('0xede9c75aa8bf4bbd6440741b4e38c9ddcde39984e5cc1080e0502a87eca6cf0a');
  });

  it('differs per agent', () => {
    expect(agentKey('agent-1')).not.toBe(agentKey('agent-2'));
  });
});
