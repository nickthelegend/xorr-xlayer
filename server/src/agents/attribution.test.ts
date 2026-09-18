import { describe, expect, it } from 'vitest';
import { agentForKind, personaForKind } from './attribution.js';
import { PERSONAS } from '../bot/personas.js';

describe('who a run belongs to', () => {
  it('names each persona exactly as the roster does', () => {
    for (const kind of ['yield-rotation', 'exit-rules', 'momentum', 'event-driven']) {
      const id = personaForKind(kind);
      expect(id).toBeDefined();
      expect(agentForKind(kind)).toBe(PERSONAS[id!].name);
    }
  });

  it('a kind no persona runs is the scheduler acting as itself', () => {
    for (const kind of ['dca', 'rebalance', 'grid', 'buy']) {
      expect(personaForKind(kind)).toBeUndefined();
      expect(agentForKind(kind)).toBe('xorr');
    }
  });
});
