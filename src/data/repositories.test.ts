/**
 * PLAN.md §3.8: "Any screen calling `fetch` directly is a bug."
 * This test is the enforcement.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('the repository boundary', () => {
  it('no screen or component calls fetch/XHR directly', () => {
    const offenders: string[] = [];
    for (const dir of ['app', 'src/design']) {
      for (const file of walk(path.join(ROOT, dir))) {
        const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        if (/\bfetch\s*\(|XMLHttpRequest|axios/.test(src)) {
          offenders.push(path.relative(ROOT, file));
        }
      }
    }
    expect(offenders, `network calls outside the data layer:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('network access lives only in src/data and src/wallet', () => {
    const allowed = ['src/data', 'src/wallet', 'src/bot'];
    const withFetch: string[] = [];
    for (const file of walk(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file);
      if (rel.endsWith('.test.ts')) continue;
      const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/\bfetch\s*\(/.test(src)) withFetch.push(rel);
    }
    for (const f of withFetch) {
      expect(allowed.some((a) => f.startsWith(a)), `${f} makes network calls`).toBe(true);
    }
  });
});
