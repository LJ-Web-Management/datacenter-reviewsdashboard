import { all, first } from './db.js';

const DAY = 86_400_000;

function makeBucketer(granularity, tzOffsetMin) {
  const shift = -tzOffsetMin * 60_000; // getTimezoneOffset() is UTC - local
  const start = (t) => {
    const d = new Date(t + shift);
    if (granularity === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    if (granularity === 'week') return day - ((d.getUTCDay() + 6) % 7) * DAY; // weeks start Monday
    return day;
  };
  const next = (key) => {
    if (granularity === 'month') {
      const d = new Date(key);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
    return key + (granularity === 'week' ? 7 : 1) * DAY;
  };
  return { start, next };
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round(n, digits = 2) {
  return n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits;
}

function reviewStats(rows) {
  const rated = rows.filter((r) => r.star_rating);
  const replied = rows.filter((r) => r.status === 'posted' || r.status === 'replied');
  const replyHours = replied
    .filter((r) => r.reply_at && r.reply_at >= r.created_at)
    .map((r) => (r.reply_at - r.created_at) / 3_600_000);
  return {
    total: rows.length,
    avgRating: rated.length ? round(rated.reduce((s, r) => s + r.star_rating, 0) / rated.length, 2) : null,
    responseRate: rows.length ? round(replied.length / rows.length, 4) : null,
    medianReplyHours: round(median(replyHours), 1),
  };
}

function usageTotals(rows) {
  const t = { costUsd: 0, requests: rows.length, failed: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, unpriced: 0 };
  for (const r of rows) {
    t.costUsd += r.cost_usd || 0;
    t.inputTokens += r.input_tokens;
    t.outputTokens += r.output_tokens;
    t.cachedTokens += r.cached_tokens;
    if (!r.success) t.failed++;
    if (r.cost_usd == null && (r.input_tokens || r.output_tokens)) t.unpriced++;
  }
  t.costUsd = round(t.costUsd, 6);
  return t;
}

export async function getAnalytics({ range = '30', tzOffset = 0 } = {}) {
  const now = Date.now();
  const days = range === 'all' ? null : Math.min(Math.max(parseInt(range, 10) || 30, 1), 3650);
  const tz = Math.min(Math.max(parseInt(tzOffset, 10) || 0, -900), 900);

  let from;
  if (days) {
    from = now - days * DAY;
  } else {
    const firstReview = (await first('SELECT MIN(created_at) AS t FROM reviews')).t;
    const firstUse = (await first('SELECT MIN(created_at) AS t FROM api_usage')).t;
    from = Math.min(firstReview ?? now, firstUse ?? now, now - 30 * DAY);
  }
  const spanDays = (now - from) / DAY;
  const granularity = spanDays <= 31 ? 'day' : spanDays <= 120 ? 'week' : 'month';

  const reviews = (await all('SELECT star_rating, status, auto_approved, created_at, reply_at FROM reviews WHERE created_at >= ?', from));
  const usage = (await all('SELECT * FROM api_usage WHERE created_at >= ?', from));

  // Previous period of equal length, for deltas.
  let previous = null;
  if (days) {
    const prevFrom = from - days * DAY;
    const prevReviews = (await all('SELECT star_rating, status, created_at, reply_at FROM reviews WHERE created_at >= ? AND created_at < ?', prevFrom, from));
    const prevUsage = (await all('SELECT * FROM api_usage WHERE created_at >= ? AND created_at < ?', prevFrom, from));
    previous = { ...reviewStats(prevReviews), costUsd: usageTotals(prevUsage).costUsd };
  }

  // Time buckets (continuous, so empty periods show as zero).
  const b = makeBucketer(granularity, tz);
  const buckets = new Map();
  for (let k = b.start(from); k <= b.start(now); k = b.next(k)) {
    buckets.set(k, { key: k, reviews: 0, ratingSum: 0, rated: 0, costUsd: 0, requests: 0, inputTokens: 0, outputTokens: 0 });
  }
  for (const r of reviews) {
    const bucket = buckets.get(b.start(r.created_at));
    if (!bucket) continue;
    bucket.reviews++;
    if (r.star_rating) { bucket.ratingSum += r.star_rating; bucket.rated++; }
  }
  for (const u of usage) {
    const bucket = buckets.get(b.start(u.created_at));
    if (!bucket) continue;
    bucket.costUsd += u.cost_usd || 0;
    bucket.requests++;
    bucket.inputTokens += u.input_tokens;
    bucket.outputTokens += u.output_tokens;
  }
  const series = [...buckets.values()].map((x) => ({
    key: x.key,
    reviews: x.reviews,
    avgRating: x.rated ? round(x.ratingSum / x.rated, 2) : null,
    costUsd: round(x.costUsd, 6),
    requests: x.requests,
    inputTokens: x.inputTokens,
    outputTokens: x.outputTokens,
  }));

  const distribution = [5, 4, 3, 2, 1].map((stars) => ({ stars, count: reviews.filter((r) => r.star_rating === stars).length }));
  const breakdown = {
    auto: reviews.filter((r) => r.status === 'posted' && r.auto_approved).length,
    manual: reviews.filter((r) => r.status === 'posted' && !r.auto_approved).length,
    external: reviews.filter((r) => r.status === 'replied').length,
    awaiting: reviews.filter((r) => ['pending', 'failed', 'posting'].includes(r.status)).length,
    skipped: reviews.filter((r) => r.status === 'skipped').length,
  };

  // Costs
  const totals = usageTotals(usage);
  const repliesPosted = (await first(`SELECT COUNT(*) AS n FROM reviews WHERE status = 'posted' AND reply_at >= ?`, from)).n;
  const allTime = (await first('SELECT COALESCE(SUM(cost_usd), 0) AS c, COUNT(*) AS n FROM api_usage'));
  const d = new Date(now - tz * 60_000);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) + tz * 60_000;
  const mtd = (await first('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM api_usage WHERE created_at >= ?', monthStart)).c;
  const last30 = (await first('SELECT COALESCE(SUM(cost_usd), 0) AS c, MIN(created_at) AS first FROM api_usage WHERE created_at >= ?', now - 30 * DAY));
  const observedDays = last30.first ? Math.max(1, (now - last30.first) / DAY) : 0;
  const projectedMonthly = observedDays ? (last30.c / Math.min(30, observedDays)) * 30 : 0;

  const byModel = (await all(`SELECT model, COUNT(*) AS requests, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
                                     COALESCE(SUM(cost_usd), 0) AS costUsd, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed
                              FROM api_usage WHERE created_at >= ? GROUP BY model ORDER BY costUsd DESC`, from));
  const byPurpose = (await all(`SELECT purpose, COUNT(*) AS requests, COALESCE(SUM(cost_usd), 0) AS costUsd
                                FROM api_usage WHERE created_at >= ? GROUP BY purpose ORDER BY costUsd DESC`, from));
  const recentErrors = (await all(`SELECT created_at AS at, model, error FROM api_usage WHERE success = 0 AND created_at >= ?
                                   ORDER BY created_at DESC LIMIT 5`, from));

  return {
    range: { key: days ? String(days) : 'all', from, to: now, granularity, tzOffset: tz },
    reviews: { ...reviewStats(reviews), distribution, breakdown },
    previous,
    series,
    costs: {
      ...totals,
      repliesPosted,
      costPerReply: repliesPosted ? round(totals.costUsd / repliesPosted, 6) : null,
      avgCostPerRequest: totals.requests ? round(totals.costUsd / totals.requests, 6) : null,
      allTimeUsd: round(allTime.c, 6),
      allTimeRequests: allTime.n,
      monthToDateUsd: round(mtd, 6),
      projectedMonthlyUsd: round(projectedMonthly, 4),
      byModel: byModel.map((m) => ({ ...m, costUsd: round(m.costUsd, 6) })),
      byPurpose: byPurpose.map((p) => ({ ...p, costUsd: round(p.costUsd, 6) })),
      recentErrors,
    },
  };
}
