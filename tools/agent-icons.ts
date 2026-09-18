/**
 * Draw agent faces to files — the same faces AgentOrb draws in the app.
 *
 *   npx tsx tools/agent-icons.ts                                    # the personas plus a spread of samples
 *   npx tsx tools/agent-icons.ts "Yield Keeper" "Night Owl" --size 512 --out ./icons
 *
 * Writes one SVG per name and an index.html contact sheet on the app's black, with each face's picks
 * under it. Everything comes from `agentGlyphSvg`, which renders the description AgentOrb renders, so
 * a file here is what the app shows for that name.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentGlyph, agentGlyphSvg } from '../src/design/agentGlyph';

const PERSONAS = ['Momentum Scout', 'Earnings Desk', 'Yield Keeper', 'Drawdown Guard', 'Strategist'];
const SAMPLES = [
  'Night Owl', 'Basis Trader', 'Grid Runner', 'Funding Hunter', 'Vol Seller', 'Mean Reverter',
  'Delta Neutral', 'Stable Parker', 'Breakout Bot', 'Carry Crab', 'Liquidity Scout', 'Gamma Ghost',
  'Rebalancer', 'Trend Surfer', 'Arb Ant', 'Risk Warden', 'Swing Owl', 'Macro Monk', 'Dip Buyer',
];

const args = process.argv.slice(2);
function option(flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

const out = path.resolve(option('--out') ?? path.join(os.tmpdir(), 'xorr-agent-icons'));
const size = Number(option('--size') ?? 256);
if (!Number.isFinite(size) || size < 16) {
  console.error(`--size must be a pixel size of at least 16, not ${size}`);
  process.exit(1);
}
const names = args.length > 0 ? args : [...PERSONAS, ...SAMPLES];

const slug = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

fs.mkdirSync(out, { recursive: true });
const cells: string[] = [];
for (const name of names) {
  fs.writeFileSync(path.join(out, `${slug(name)}.svg`), `${agentGlyphSvg(name, size)}\n`);
  const g = agentGlyph(name);
  cells.push(
    `<figure>${agentGlyphSvg(name, 104)}<figcaption><b>${escape(name)}</b>` +
      `<span>${g.eyes} · ${g.mouth} · ${g.mark}</span></figcaption></figure>`,
  );
}

fs.writeFileSync(
  path.join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>xorr — agent faces</title>
<style>
  body { margin: 0; padding: 36px; background: #000; color: #fff; font: 13px/1.4 -apple-system, system-ui, sans-serif; }
  h1 { margin: 0 0 22px; color: #8A8A90; font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; }
  figure { margin: 0; padding: 20px 8px 16px; display: flex; flex-direction: column; align-items: center; gap: 12px;
           background: #0C0C0D; border: 1px solid rgba(255,255,255,.06); border-radius: 20px; }
  figcaption { display: flex; flex-direction: column; align-items: center; gap: 3px; text-align: center; }
  figcaption span { color: #8A8A90; font-size: 11px; }
</style>
<h1>Agent faces · agentGlyph(name)</h1>
<main>${cells.join('\n')}</main>
`,
);

console.log(`${names.length} faces → ${out}`);
console.log(`  ${path.join(out, 'index.html')}`);
