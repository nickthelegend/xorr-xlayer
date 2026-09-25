import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '@/data/types';
import { bannerFor, freshTrades, MAX_BANNERS } from './tradeNotices';

const row = (id: number, kind: ActivityEvent['kind'] = 'trade', over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: String(id),
  t: '10:00 AM',
  agent: 'Tesla Buyer',
  action: 'Bought 0.0610 TSLAx',
  detail: '$25 of TSLAx, the weekly buy.',
  amount: '-$25.00',
  kind,
  ...over,
});

describe('which rows raise a banner', () => {
  it('raises nothing on the first read, and remembers where the trail stood', () => {
    expect(freshTrades([row(7), row(9), row(8)], undefined)).toEqual({ banners: [], newest: 9 });
  });

  it('raises a fill that arrives after that, and moves the mark past it', () => {
    const { banners, newest } = freshTrades([row(10), row(9), row(8)], 9);
    expect(banners.map((e) => e.id)).toEqual(['10']);
    expect(newest).toBe(10);
  });

  it('raises fills and cash put to work, not refusals or notes', () => {
    const { banners } = freshTrades([row(11, 'trade'), row(12, 'block'), row(13, 'risk'), row(14, 'yield')], 10);
    expect(banners.map((e) => e.id)).toEqual(['11', '14']);
  });

  it('shows the newest few of a backlog, oldest first', () => {
    const backlog = [1, 2, 3, 4, 5, 6].map((n) => row(100 + n));
    const { banners, newest } = freshTrades(backlog, 100);
    expect(banners.map((e) => e.id)).toEqual(['104', '105', '106']);
    expect(banners).toHaveLength(MAX_BANNERS);
    expect(newest).toBe(106);
  });

  it('keeps its mark when the trail comes back empty or unreadable', () => {
    expect(freshTrades([], 42)).toEqual({ banners: [], newest: 42 });
    expect(freshTrades([row(Number.NaN)], 42)).toEqual({ banners: [], newest: 42 });
  });
});

describe('what a banner says', () => {
  it("names the agent and what it did, carries the row's sentence, and opens that row on tap", () => {
    expect(bannerFor(row(15))).toEqual({
      title: 'Tesla Buyer · Bought 0.0610 TSLAx',
      body: '$25 of TSLAx, the weekly buy.',
      data: { kind: 'dca-executed', seq: '15', route: '/activity' },
    });
  });

  it('falls back to the action alone when no agent is named', () => {
    expect(bannerFor(row(16, 'trade', { agent: '' })).title).toBe('Bought 0.0610 TSLAx');
  });
});
