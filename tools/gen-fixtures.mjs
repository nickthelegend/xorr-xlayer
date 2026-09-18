/**
 * Generates src/data/fixtures/* from the design handoff.
 * Closes: G4 (counts), G5 (sparklines), G6 (equity curves), G7 (area paths), G12 (U+2212).
 * Run: node tools/gen-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HANDOFF = path.join(ROOT, 'ui/mobile-ui/data/markets.json');
const OUT = path.join(ROOT, 'src/data/fixtures');
const raw = JSON.parse(fs.readFileSync(HANDOFF, 'utf8'));

const MINUS = '−';
/** G12: the handoff mixes '-' and U+2212 in change strings. Normalise every numeric field. */
const fixMinus = (s) => (typeof s === 'string' ? s.replace(/-(?=[\d.])/g, MINUS) : s);

/**
 * G4: README says 43 instruments, screens.md says 9 pre-IPO, the file has 44 with 8 pre-IPO.
 * Reconciled to 9 per class = 45. The 9th pre-IPO is added here, in the handoff's own idiom
 * (a pre-IPO perp, gradient stops in the same family).
 */
const PREIPO_9TH = {
  sym: 'CANVA',
  name: 'Canva',
  tag: 'Pre-IPO perp',
  px: '$41.20',
  chg: '+1.35%',
  up: true,
  c1: '#7FD6F5',
  c2: '#1D7FA8',
};

/** Which classes have a real price feed today. PLAN.md §1.3 item 8 / task 12.13. */
const LIVE_CLASSES = new Set(['crypto']);

/** Solana mints for the crypto instruments a live feed can price. */
const MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  DOGE: '2wme8EVkw8qsfSk2B3QeX4S64ac6wxHPXb3GrdckEkio',
  LINK: 'CWE8jPTUYhdCTZYWPTe1o5DFqfdjzWKc9WKz6rSjQUdG',
  AAVE: '3vAs4D1WE6Na4tCgt4BApgFfENbm8WY7q4cSPD1yM4Cg',
  XRP: 'Ga2AXHpqdfyDBFcefJit2Qm7GRhCPkTBQzFnkULRC2ZH',
  TON: 'GEYrotdkRitGUK5UMv3aMttEhVAZLhRJMcG82zKYsaWB',
  HYPE: '',
};

const classes = raw.classes.map((c) => {
  const instruments = [...c.instruments];
  if (c.id === 'preipo' && instruments.length === 8) instruments.push(PREIPO_9TH);
  return {
    id: c.id,
    label: c.label,
    note: c.note,
    more: c.more,
    instruments: instruments.map((i) => ({
      sym: i.sym,
      name: i.name,
      tag: i.tag,
      px: fixMinus(i.px),
      chg: fixMinus(i.chg),
      up: i.up,
      c1: i.c1,
      c2: i.c2,
      classId: c.id,
      feed: LIVE_CLASSES.has(c.id) ? 'live' : 'simulated',
      ...(MINTS[i.sym] ? { mint: MINTS[i.sym] } : {}),
    })),
  };
});

const total = classes.reduce((a, c) => a + c.instruments.length, 0);
if (total !== 45) throw new Error(`expected 45 instruments after reconciliation, got ${total}`);
for (const c of classes) {
  if (c.instruments.length !== 9) throw new Error(`${c.id} has ${c.instruments.length}, expected 9`);
}
// The "See all N" strings quote counts that must not contradict the reconciled totals.
classes.find((c) => c.id === 'preipo').more = 'See all 12 pre-IPO perps';

/**
 * G5: sparklines existed only inline in the prototype's `data` object (5 groups / 11 rows).
 * Lifted verbatim into data, with the minus signs normalised.
 */
const watchlistGroups = [
  {
    label: 'Tokens',
    tab: 'Conviction List',
    rows: [
      { sym: 'TSLAx', px: '$389.82', chg: '+0.9%', up: true, spark: '0,22 12,18 24,20 36,12 48,15 60,8 72,11 90,4' },
      { sym: 'SOL', px: '$88.32', chg: '+2.4%', up: true, spark: '0,20 14,14 26,17 38,9 52,13 66,7 78,10 90,5' },
      { sym: 'HYPE', px: '$40.96', chg: `${MINUS}1.2%`, up: false, spark: '0,8 14,12 28,10 40,17 54,14 68,20 80,18 90,24' },
    ],
  },
  {
    label: 'Metals',
    tab: 'Metals',
    rows: [
      { sym: 'XAUt', px: '$3,412.10', chg: '+0.4%', up: true, spark: '0,20 16,17 30,18 44,12 58,14 74,9 90,7' },
      { sym: 'XAGx', px: '$38.71', chg: `${MINUS}0.6%`, up: false, spark: '0,10 16,13 30,11 46,16 60,15 74,19 90,21' },
    ],
  },
  {
    label: 'Equities',
    tab: 'Stocks',
    rows: [
      { sym: 'NVDAx', px: '$182.44', chg: '+1.8%', up: true, spark: '0,24 14,19 28,21 42,13 56,15 72,8 90,5' },
      { sym: 'AAPLx', px: '$241.09', chg: '+0.2%', up: true, spark: '0,17 16,15 32,16 48,13 64,14 78,11 90,12' },
      { sym: 'COINx', px: '$318.55', chg: `${MINUS}2.1%`, up: false, spark: '0,7 16,11 30,9 44,15 60,17 76,16 90,23' },
    ],
  },
  {
    label: 'Protocols',
    tab: 'Defi',
    rows: [
      { sym: 'AAVE', px: '$291.03', chg: '+3.1%', up: true, spark: '0,25 14,20 30,22 46,12 62,14 78,7 90,4' },
      { sym: 'JUP', px: '$0.87', chg: `${MINUS}0.4%`, up: false, spark: '0,11 18,14 34,12 50,16 66,15 90,20' },
    ],
  },
  {
    label: 'Overview',
    tab: 'Overview',
    rows: [
      { sym: 'Total', px: '$4,862.18', chg: '+0.3%', up: true, spark: '0,21 18,17 34,18 50,13 66,12 82,9 90,8' },
    ],
  },
];

/** G6: equity curves lived in `btData` inside the HTML. */
const backtest = [
  { lookback: '30d', ret: 4.2, maxDd: -2.1, sharpe: 1.4, trades: 18,
    curve: '0,96 40,92 80,86 120,88 160,78 200,74 240,70 280,66 320,58 360,52' },
  { lookback: '90d', ret: 11.8, maxDd: -5.4, sharpe: 1.7, trades: 54,
    curve: '0,100 40,94 80,88 120,80 160,84 200,70 240,62 280,58 320,44 360,32' },
  { lookback: '6m', ret: 23.5, maxDd: -9.2, sharpe: 1.2, trades: 121,
    curve: '0,102 40,90 80,96 120,78 160,66 200,72 240,54 280,46 320,34 360,20' },
  { lookback: '1y', ret: 41.9, maxDd: -14.6, sharpe: 1.1, trades: 244,
    curve: '0,104 40,96 80,84 120,90 160,70 200,58 240,64 280,44 320,28 360,10' },
];

/** G7: area-chart geometry was hardcoded SVG point strings in the prototype. */
const areaSeries = {
  /** Screen 25, gold, 132px. Verbatim from the prototype's polygon/polyline. */
  XAUT: '0,84 30,78 60,82 92,64 124,70 156,52 188,58 220,42 252,48 284,32 316,38 360,24',
  /** Screen 13, SOL, 170px. */
  SOL: '0,92 32,86 64,88 96,72 128,76 160,60 192,66 224,50 256,54 288,38 320,42 360,26',
};

const bars = raw.candles_ohlc.bars;

const agents = raw.agents.map((a, i) => ({
  id: a.name.toLowerCase().replace(/\s+/g, '-'),
  name: a.name,
  role: a.role,
  // The live leaderboard replaces this from the real trade record; the seeded value must not
  // carry a rate the app cannot verify.
  metric: a.metric.includes('APY') ? 'Moves idle cash to the best rate' : a.metric,
  pnl30d: a.pnl30d,
  win: a.win,
  trades: a.trades,
  c1: a.c1,
  c2: a.c2,
}));

/**
 * The handoff quotes "12.6% APY" in the activity and news fixtures. The live rate derived from
 * Solana's inflation schedule is materially lower (see server/src/venues/staking.ts), so the
 * unverified figure is removed rather than shipped. copy.md: never oversell.
 */
const stripApy = (s) => {
  if (typeof s !== 'string') return s;
  return s
    .replace(/\s*·?\s*12\.6%\s*APY\s*·?\s*/g, ' ')
    .replace(/\s*to\s*12\.6%/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*·\s*|\s*·\s*$/g, '')
    .trim();
};

const activity = raw.activity.map((a, i) => ({
  id: `act-${i}`,
  t: a.t,
  agent: a.agent,
  action: a.action,
  detail: stripApy(fixMinus(a.detail)),
  amount: fixMinus(a.amount),
  kind: a.kind,
}));

const alerts = raw.alerts.map((a, i) => ({ id: `alert-${i}`, ...a }));
const news = raw.news.map((n, i) => ({ id: `news-${i}`, ...n, headline: stripApy(n.headline), take: stripApy(n.take) }));

const banner = `/**
 * GENERATED by tools/gen-fixtures.mjs from ui/mobile-ui/data/markets.json — do not edit by hand.
 *
 * Applied on the way through:
 *   G4  counts reconciled to 9 per class (45 total); the 9th pre-IPO instrument added.
 *   G12 every numeric field normalised to U+2212.
 *   feed: 'live' | 'simulated' stamped per class so the UI can label synthetic prices.
 */\n`;

fs.mkdirSync(OUT, { recursive: true });
const w = (file, name, value, type) =>
  fs.writeFileSync(
    path.join(OUT, file),
    banner +
      `import type { ${type.replace('[]', '')} } from '../types';\n\n` +
      `export const ${name}: ${type} = ${JSON.stringify(value, null, 2)};\n`,
  );

w('markets.ts', 'assetClasses', classes, 'AssetClass[]');
w('agents.ts', 'agentFixtures', agents, 'Agent[]');
w('activity.ts', 'activityFixtures', activity, 'ActivityEvent[]');
w('alerts.ts', 'alertFixtures', alerts, 'Alert[]');
w('news.ts', 'newsFixtures', news, 'NewsItem[]');
w('backtest.ts', 'backtestFixtures', backtest, 'BacktestResult[]');
w('sleeves.ts', 'sleeveFixtures', raw.portfolio_sleeves, 'Sleeve[]');

fs.writeFileSync(
  path.join(OUT, 'series.ts'),
  banner +
    `import type { Bar, WatchlistGroup } from '../types';\n\n` +
    `/** G5: sparkline polylines, lifted out of the prototype's inline \`data\` object. */\n` +
    `export const watchlistGroups: WatchlistGroup[] = ${JSON.stringify(watchlistGroups, null, 2)};\n\n` +
    `/** G7: area-chart geometry, lifted out of hardcoded SVG point strings. */\n` +
    `export const areaSeries: Record<string, string> = ${JSON.stringify(areaSeries, null, 2)};\n\n` +
    `/** The 12 hourly BTC/USD bars shared by screens 21 and 6. design.md §6. */\n` +
    `export const btcBars: Bar[] = ${JSON.stringify(bars)};\n`,
);

fs.writeFileSync(
  path.join(OUT, 'onboarding.ts'),
  banner +
    `export const onboarding = ${JSON.stringify(raw.onboarding, null, 2)} as const;\n\n` +
    `export const agentControls = ${JSON.stringify(raw.agent_controls, null, 2)} as const;\n\n` +
    `export const chatProposal = ${JSON.stringify(raw.chat_proposal, null, 2)} as const;\n`,
);

fs.writeFileSync(
  path.join(OUT, 'index.ts'),
  `export * from './markets';\nexport * from './agents';\nexport * from './activity';\n` +
    `export * from './alerts';\nexport * from './news';\nexport * from './backtest';\n` +
    `export * from './sleeves';\nexport * from './series';\nexport * from './onboarding';\n`,
);

console.log(`ok: ${classes.length} classes, ${total} instruments, ${agents.length} agents, ${bars.length} bars`);
