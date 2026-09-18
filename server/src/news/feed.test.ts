import { describe, expect, it } from 'vitest';
import { parseRss, relativeTime, relevant, type Headline } from './feed.js';

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[Solana staking yield ticks up]]></title><link>https://x/1</link><pubDate>Sat, 05 Sep 2026 12:00:00 GMT</pubDate></item>
<item><title>Fed holds, signals one more cut</title><link>https://x/2</link><pubDate>Sat, 05 Sep 2026 10:00:00 GMT</pubDate></item>
<item><title>Bitcoin &amp; friends rally</title><link>https://x/3</link></item>
</channel></rss>`;

describe('12.24 news ingestion [G34]', () => {
  it('parses titles, links and dates out of real RSS shapes', () => {
    const items = parseRss(RSS, 'MACRO');
    expect(items).toHaveLength(3);
    expect(items[0]!.title).toBe('Solana staking yield ticks up'); // CDATA unwrapped
    expect(items[0]!.link).toBe('https://x/1');
    expect(items[2]!.title).toBe('Bitcoin & friends rally'); // entity decoded
    expect(items[0]!.at).toBeGreaterThan(0);
  });

  it('filters to the user’s book — screen 23 promises exactly that', () => {
    const items = parseRss(RSS, 'MACRO');
    const forSol = relevant(items, ['SOL']);
    expect(forSol.map((h) => h.symbol)).toEqual(['SOL']);
    expect(forSol[0]!.title).toContain('Solana');

    const forBtc = relevant(items, ['BTC']);
    expect(forBtc[0]!.title).toContain('Bitcoin');

    // A headline about nothing you hold is not your briefing.
    expect(relevant(items, ['DOGE'])).toHaveLength(0);
  });

  it('matches on the asset name as well as the ticker', () => {
    const items: Headline[] = [
      { tag: 'MACRO', title: 'Ethereum upgrade lands', at: Date.now(), link: '' },
    ];
    expect(relevant(items, ['ETH'])).toHaveLength(1);
  });

  it('formats relative times the way screen 23 shows them', () => {
    const now = Date.parse('2026-09-05T12:00:00Z');
    expect(relativeTime(now - 18 * 60_000, now)).toBe('18m');
    expect(relativeTime(now - 2 * 3600_000, now)).toBe('2h');
    expect(relativeTime(now - 50 * 3600_000, now)).toBe('2d');
  });
});
