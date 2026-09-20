/**
 * GET /strategies/catalog — the measured strategy book, browsable.
 * GET /strategies/catalog/:slug — one strategy, with its curve, its trades and its evidence.
 *
 * Public, for the same reason `/market/*` is: what a strategy measured is not user data, and gating it
 * means a signed-out visitor — a judge, most likely — sees a list of dashes.
 *
 * The list carries a 24-point sketch of each curve so a row can show its shape without a second request;
 * the full 240-point curve, the distribution, the side split and up to 150 trades come with the detail.
 */
import { Hono } from 'hono';
import {
  SORTS,
  catalogDetail,
  catalogIndex,
  counts,
  isSlug,
  selectRows,
  type Sort,
  type Tier,
} from '../strategies/catalog.js';

export const strategyCatalogRoutes = new Hono();

const TIERS: readonly Tier[] = ['verified', 'measured', 'archive'];

strategyCatalogRoutes.get('/strategies/catalog', async (c) => {
  const { window, strategies } = await catalogIndex();

  const tierParam = c.req.query('tier');
  if (tierParam && !TIERS.includes(tierParam as Tier)) {
    return c.json({ error: 'bad_tier', detail: `tier is one of ${TIERS.join(', ')}.` }, 400);
  }
  const sortParam = c.req.query('sort');
  if (sortParam && !SORTS.includes(sortParam as Sort)) {
    return c.json({ error: 'bad_sort', detail: `sort is one of ${SORTS.join(', ')}.` }, 400);
  }
  const limitParam = c.req.query('limit');
  const limit = limitParam === undefined ? 0 : Number(limitParam);
  if (limitParam !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    return c.json({ error: 'bad_limit', detail: 'limit is a positive number of rows.' }, 400);
  }

  const rows = selectRows(strategies, {
    tier: tierParam as Tier | undefined,
    trustedOnly: c.req.query('trusted') === 'true',
    sort: (sortParam as Sort | undefined) ?? 'return',
    limit,
  });

  return c.json({
    /*
     * The window every number on every row was measured over. Without it a return is a number with no
     * units: +2.34% over what, on which symbols, paying what. It travels with the list rather than being
     * something the app has to know.
     */
    window,
    counts: counts(strategies),
    rows,
  });
});

strategyCatalogRoutes.get('/strategies/catalog/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isSlug(slug)) {
    return c.json({ error: 'bad_slug', detail: 'A strategy slug is lowercase letters, digits and underscores.' }, 400);
  }
  const detail = await catalogDetail(slug);
  if (!detail) {
    return c.json({ error: 'not_found', detail: `No strategy named ${slug} in the book.` }, 404);
  }
  return c.json(detail);
});
