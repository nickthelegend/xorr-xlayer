/**
 * The agent's decision word, held against the constraint that has to accept it.
 *
 * `proposals.decision` is a CHECK column, and the agent wrote `'approved'` into it while the
 * constraint allowed only `'approve'`. Postgres refused every insert; the call site logged and
 * carried on, so no decision record was ever stored and the sweep's cooldown — which matches on
 * that same value — matched nothing, leaving the agent free to trade on every tick.
 *
 * Nothing in the type system connects a string literal in TypeScript to a CHECK clause in a `.sql`
 * file, so this reads the schema and does it. It is deliberately a parse of the real file rather
 * than a second copy of the list: a copy would have been just as wrong as the literal was.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_DECISION } from './autonomous.js';

const schema = readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8');

/** The literals inside `decision IN (...)`, straight out of the CREATE TABLE. */
function allowedDecisions(): string[] {
  const clause = /decision\s+TEXT\s+CHECK\s*\(\s*decision\s+IN\s*\(([^)]*)\)/i.exec(schema);
  if (!clause?.[1]) throw new Error('could not find the decision CHECK clause in schema.sql');
  return [...clause[1].matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('agent decision vocabulary', () => {
  it('finds a real CHECK clause to read', () => {
    // If the column ever stops being constrained, this test is measuring nothing and should say so.
    expect(allowedDecisions().length).toBeGreaterThan(0);
  });

  it('writes a decision the proposals constraint actually accepts', () => {
    expect(allowedDecisions()).toContain(AGENT_DECISION);
  });

  it('does not write the plural form Postgres rejected', () => {
    expect(AGENT_DECISION).not.toBe('approved');
  });
});
