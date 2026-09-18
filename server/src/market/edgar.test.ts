/**
 * The calendar's two hazards, both found in the real filing data.
 *
 * Tesla files an Item 2.02 for quarterly deliveries as well as for results, so its raw gaps read
 * `[20, 71, 20, 64, 26, 72]` and a median of those projects a date six weeks wrong. And not every
 * filer is quarterly — a cadence this module does not recognise must produce no projection at all,
 * because tier 7 stands down on a null and guesses on a number.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const fetched = vi.fn();
// Forward every argument: `getJson(url, ttlMs, timeoutMs, headers)`. Passing only the first
// silently hands the implementation `undefined` when anything calls it positionally.
vi.mock('../http/get.js', () => ({ getJson: (...args: unknown[]) => fetched(...args) }));

const { earningsCalendar, underlyingTicker, reportDates } = await import('./edgar.js');

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** A submissions payload with the given Item 2.02 filing dates, newest first. */
function submissions(dates: string[]) {
  return {
    filings: {
      recent: {
        form: dates.map(() => '8-K'),
        filingDate: dates,
        items: dates.map(() => '2.02,9.01'),
      },
    },
  };
}

const tickers = { '0': { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' } };

function serve(dates: string[]) {
  fetched.mockImplementation((url: string) =>
    Promise.resolve(String(url).includes('company_tickers') ? tickers : submissions(dates)),
  );
}

beforeEach(() => fetched.mockReset());

describe('the tokenized symbol names a real company', () => {
  it('strips the suffix that marks the tokenized form', () => {
    expect(underlyingTicker('NVDAc')).toBe('NVDA');
    expect(underlyingTicker('GOOGLc')).toBe('GOOGL');
    // Already bare, or crypto — unchanged rather than mangled.
    expect(underlyingTicker('NVDA')).toBe('NVDA');
  });
});

describe('a quarter can carry more than one Item 2.02', () => {
  it('collapses Tesla-shaped duplicates into one print per quarter', async () => {
    // Deliveries then results, twice — the exact shape that produced a 45-day median.
    serve(['2026-07-22', '2026-07-02', '2026-04-22', '2026-04-02', '2026-01-28', '2026-01-02']);
    const c = await earningsCalendar('NVDAc');
    expect(c!.reported.map(iso)).toEqual(['2026-07-22', '2026-04-22', '2026-01-28']);
    expect(c!.medianGapDays).toBeGreaterThanOrEqual(80);
    expect(c!.medianGapDays).toBeLessThanOrEqual(100);
  });
});

describe('the projection', () => {
  it('projects one median gap past the last print', async () => {
    serve(['2026-07-30', '2026-04-30', '2026-01-29', '2025-10-30']);
    const c = await earningsCalendar('NVDAc');
    expect(c!.medianGapDays).toBe(91);
    expect(iso(c!.nextAt!)).toBe(iso(c!.reported[0]! + 91 * DAY));
  });

  it('carries no margin for a metronomic filer, and real margin for an erratic one', async () => {
    serve(['2026-07-30', '2026-04-30', '2026-01-29', '2025-10-30']); // exactly 91 apart
    expect((await earningsCalendar('NVDAc'))!.errorDays).toBe(0);

    // 98 / 84 / 98 — NVIDIA's actual shape. The margin must come from the filings, not a constant.
    serve(['2026-08-26', '2026-05-20', '2026-02-25', '2025-11-19']);
    const erratic = await earningsCalendar('NVDAc');
    expect(erratic!.errorDays).toBeGreaterThan(0);
    expect(erratic!.errorDays).toBe(Math.max(...erratic!.gapDays.map((g) => Math.abs(g - erratic!.medianGapDays!))));
  });

  it('refuses to project a cadence it does not recognise', async () => {
    /*
     * Monthly filings. Real dates, real filings, and not a quarterly pattern.
     *
     * The deduplication thins them to 61-day gaps — 07-01 and 05-01 survive, the two between them
     * fall inside the same-quarter window. 61 is still outside the quarterly band, so the answer is
     * no projection. That the dedupe cannot manufacture a quarterly cadence out of a monthly one is
     * the property worth pinning: it thins, and then the band decides.
     */
    // Semi-annual: four filings, all surviving the dedupe, median 181 days.
    serve(['2026-07-01', '2026-01-01', '2025-07-01', '2025-01-01']);
    const c = await earningsCalendar('NVDAc');
    expect(c!.reported.length).toBe(4);
    expect(c!.medianGapDays).toBeGreaterThan(100);
    // Enough history to compute a cadence, and the cadence is not one this module claims to read.
    expect(c!.nextAt).toBeNull();
  });

  it('cannot manufacture a quarterly cadence out of a monthly one', async () => {
    /*
     * The dedupe thins monthly filings to 61-day gaps, which could look quarterly if the band were
     * loose. It is not: 61 is outside it, and here the thinning also leaves too little history. The
     * property is that dedupe only ever REMOVES, and the band then decides — neither step can
     * invent a pattern.
     */
    serve(['2026-07-01', '2026-06-01', '2026-05-01', '2026-04-01']);
    const c = await earningsCalendar('NVDAc');
    expect(c!.reported.length).toBe(2);
    expect(c!.nextAt).toBeNull();
  });

  it('refuses to project from too little history', async () => {
    serve(['2026-07-30', '2026-04-30']);
    const c = await earningsCalendar('NVDAc');
    expect(c!.nextAt).toBeNull();
  });

  it('is null for a symbol the SEC has never heard of', async () => {
    fetched.mockImplementation(() => Promise.resolve(tickers));
    expect(await earningsCalendar('WETH')).toBeNull();
  });
});

describe('only results filings count', () => {
  it('ignores 8-Ks that are not Item 2.02, and every other form', async () => {
    fetched.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('company_tickers')
          ? tickers
          : {
              filings: {
                recent: {
                  form: ['8-K', '8-K', '10-Q', '8-K'],
                  filingDate: ['2026-07-30', '2026-07-15', '2026-07-10', '2026-04-30'],
                  items: ['2.02,9.01', '5.02', '', '2.02'],
                },
              },
            },
      ),
    );
    // 5.02 is a director change; the 10-Q is the quarterly report, not the announcement.
    expect((await reportDates(1045810)).map(iso)).toEqual(['2026-07-30', '2026-04-30']);
  });
});
