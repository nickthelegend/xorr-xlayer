import { describe, expect, it } from 'vitest';
import { agentForKind, personaForKind, personaByName } from './attribution.js';
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

/*
 * The inverse, for reading back what was written. An agent's own order is a `buy`, which no persona runs by kind, so
 * the only thing naming the agent on that row is the name this module produced when the order was placed.
 */
describe('a name read back', () => {
  it('resolves to the persona that wrote it', () => {
    for (const kind of ['momentum', 'event-driven', 'yield-rotation', 'exit-rules']) {
      expect(personaByName(agentForKind(kind))).toBe(personaForKind(kind));
    }
  });

  it('is nobody for the system acting as itself, or for a name no persona has', () => {
    expect(personaByName('xorr')).toBeUndefined();
    expect(personaByName('Momentum scout')).toBeUndefined();
    expect(personaByName('')).toBeUndefined();
    expect(personaByName(null)).toBeUndefined();
    expect(personaByName(42)).toBeUndefined();
  });
});
