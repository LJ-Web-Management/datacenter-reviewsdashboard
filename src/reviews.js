import { config } from './runtime.js';
import { all, first, run, audit, getSetting, setSetting, acquireLock, releaseLock } from './db.js';
import { AppError } from './crypto.js';
import { generateReply, noDashes, MAX_REPLY_CHARS } from './openai.js';
import { getAppSettings, getGoogleConnection, getOpenAIKey, isDemoMode } from './settings.js';
import * as google from './google.js';
import { addIncomingDemoReview, clearDemoData } from './demo.js';

export function serializeReview(r) {
  return {
    id: r.id,
    source: r.source,
    reviewerName: r.reviewer_name || 'A Google User',
    reviewerPhoto: r.reviewer_photo || null,
    starRating: r.star_rating,
    comment: r.comment || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    status: r.status,
    suggestedReply: r.suggested_reply || '',
    draftedAt: r.drafted_at,
    replyText: r.reply_text || '',
    replyAt: r.reply_at,
    autoApproved: !!r.auto_approved,
    postedBy: r.posted_by_email || null,
    error: r.error || null,
  };
}

export function getReview(id) {
  return first('SELECT r.*, u.email AS posted_by_email FROM reviews r LEFT JOIN users u ON u.id = r.posted_by WHERE r.id = ?', id);
}

export async function draftReply(review, purpose = 'draft') {
  const text = await generateReply(review, { purpose, reviewId: review.id });
  await run('UPDATE reviews SET suggested_reply = ?, drafted_at = ?, error = NULL WHERE id = ?', text, Date.now(), review.id);
  return text;
}

/**
 * Post a reply to Google (or simulate it for demo reviews).
 * The status flip to 'posting' is atomic, so double clicks or a concurrent auto-approve can't post twice.
 */
export async function postReply(reviewId, text, { user = null, auto = false } = {}) {
  const reply = noDashes(String(text || '').trim());
  if (!reply) throw new AppError('The reply is empty.');
  if (reply.length > MAX_REPLY_CHARS) throw new AppError(`Replies can be at most ${MAX_REPLY_CHARS} characters.`);

  const claimed = await run(`UPDATE reviews SET status = 'posting', suggested_reply = ? WHERE id = ? AND status IN ('pending', 'failed')`, reply, reviewId);
  if (!claimed.changes) throw new AppError('This review was already handled. Refresh to see its latest status.', 409);

  const review = await getReview(reviewId);
  try {
    if (review.source === 'google') await google.postReply(review.external_id, reply);
    await run(`UPDATE reviews SET status = 'posted', reply_text = ?, reply_at = ?, auto_approved = ?, posted_by = ?, error = NULL WHERE id = ?`,
      reply, Date.now(), auto ? 1 : 0, user?.id ?? null, reviewId);
    await audit(user, auto ? 'reply_auto_posted' : 'reply_posted', `${review.star_rating}★ review by ${review.reviewer_name}`);
  } catch (err) {
    await run(`UPDATE reviews SET status = 'failed', error = ? WHERE id = ?`, String(err.message).slice(0, 500), reviewId);
    await audit(user, 'reply_failed', `${review.reviewer_name}: ${err.message}`.slice(0, 500));
    throw err;
  }
  return getReview(reviewId);
}

// Upserts every fetched review in ONE statement (keeps Cloudflare D1 query counts low).
// - new reviews: 'replied' if Google already has a reply, else 'pending'
// - existing: refresh details; mark 'replied' if someone replied on Google; drop a stale draft if the review text changed
const UPSERT_GOOGLE = `
INSERT INTO reviews (external_id, source, reviewer_name, reviewer_photo, star_rating, comment, created_at, updated_at,
                     status, reply_text, reply_at, first_seen_at)
SELECT json_extract(j.value, '$.externalId'), 'google', json_extract(j.value, '$.reviewerName'), json_extract(j.value, '$.reviewerPhoto'),
       json_extract(j.value, '$.starRating'), json_extract(j.value, '$.comment'), json_extract(j.value, '$.createdAt'),
       json_extract(j.value, '$.updatedAt'),
       CASE WHEN json_extract(j.value, '$.replyText') IS NOT NULL THEN 'replied' ELSE 'pending' END,
       json_extract(j.value, '$.replyText'), json_extract(j.value, '$.replyAt'), ?
FROM json_each(?) AS j WHERE true
ON CONFLICT(external_id) DO UPDATE SET
  reviewer_name = excluded.reviewer_name,
  reviewer_photo = excluded.reviewer_photo,
  star_rating = excluded.star_rating,
  updated_at = excluded.updated_at,
  status = CASE WHEN excluded.reply_text IS NOT NULL AND reviews.status IN ('pending', 'failed', 'skipped') THEN 'replied' ELSE reviews.status END,
  reply_text = CASE WHEN excluded.reply_text IS NOT NULL AND reviews.status IN ('pending', 'failed', 'skipped') THEN excluded.reply_text ELSE reviews.reply_text END,
  reply_at = CASE WHEN excluded.reply_text IS NOT NULL AND reviews.status IN ('pending', 'failed', 'skipped') THEN excluded.reply_at ELSE reviews.reply_at END,
  error = CASE WHEN excluded.reply_text IS NOT NULL AND reviews.status IN ('pending', 'failed', 'skipped') THEN NULL ELSE reviews.error END,
  suggested_reply = CASE WHEN excluded.reply_text IS NULL AND reviews.status = 'pending' AND reviews.comment IS NOT excluded.comment THEN NULL ELSE reviews.suggested_reply END,
  drafted_at = CASE WHEN excluded.reply_text IS NULL AND reviews.status = 'pending' AND reviews.comment IS NOT excluded.comment THEN NULL ELSE reviews.drafted_at END,
  comment = excluded.comment`;

async function upsertGoogleReviews(items) {
  const before = (await first("SELECT COUNT(*) AS n FROM reviews WHERE source = 'google'")).n;
  const rows = items.map((r) => ({
    externalId: r.externalId, reviewerName: r.reviewerName, reviewerPhoto: r.reviewerPhoto, starRating: r.starRating,
    comment: r.comment, createdAt: r.createdAt, updatedAt: r.updatedAt, replyText: r.reply?.text ?? null, replyAt: r.reply?.at ?? null,
  }));
  await run(UPSERT_GOOGLE, Date.now(), JSON.stringify(rows)); // params in order: first_seen_at, rows
  const after = (await first("SELECT COUNT(*) AS n FROM reviews WHERE source = 'google'")).n;
  return after - before;
}

/** Draft replies for pending reviews and auto-post those whose rating is set to auto-approve. */
async function processPending(summary) {
  const settings = await getAppSettings();
  const cfg = config();
  const autoStars = settings.autoApprove.enabled ? settings.autoApprove.stars : [];

  if (await getOpenAIKey()) {
    const needDraft = (await all(`SELECT * FROM reviews WHERE status = 'pending' AND suggested_reply IS NULL ORDER BY created_at DESC LIMIT ?`, cfg.maxDraftsPerSync * 4))
      .filter((r) => settings.autoDraft || autoStars.includes(r.star_rating))
      .slice(0, cfg.maxDraftsPerSync);
    for (const review of needDraft) {
      try {
        await draftReply(review, 'draft');
        summary.drafted++;
      } catch (err) {
        summary.errors.push(`Drafting failed: ${err.message}`);
        break; // most likely a key/quota problem; don't hammer the API
      }
    }
  } else if (await first(`SELECT 1 AS x FROM reviews WHERE status = 'pending' AND suggested_reply IS NULL LIMIT 1`)) {
    summary.errors.push('No OpenAI API key, so new reviews were not drafted.');
  }

  if (autoStars.length) {
    const marks = autoStars.map(() => '?').join(',');
    const toPost = await all(`SELECT id, suggested_reply FROM reviews WHERE status = 'pending' AND suggested_reply IS NOT NULL
                              AND star_rating IN (${marks}) ORDER BY created_at ASC LIMIT ?`, ...autoStars, cfg.maxAutoPostsPerSync);
    for (const r of toPost) {
      try {
        await postReply(r.id, r.suggested_reply, { auto: true });
        summary.autoPosted++;
      } catch (err) {
        summary.errors.push(`Auto-post failed: ${err.message}`);
      }
    }
  }
}

/**
 * Fetch new Google reviews, draft replies, run auto-approve.
 * `force` (manual "Sync now") ignores the interval; the cron trigger only syncs when it's due.
 */
export async function runSync({ manual = false, user = null } = {}) {
  if (!manual) {
    const last = await getSetting('lastSync', null);
    const minutes = (await getAppSettings()).syncIntervalMinutes;
    if (last?.finishedAt && Date.now() - last.finishedAt < (minutes - 1) * 60_000) return { skipped: true };
  }
  if (!(await acquireLock('sync', 10 * 60_000))) {
    if (manual) throw new AppError('A sync is already running. Try again in a minute.', 409);
    return { skipped: true };
  }
  const summary = { startedAt: Date.now(), fetched: 0, newReviews: 0, drafted: 0, autoPosted: 0, errors: [] };
  try {
    const conn = await getGoogleConnection();
    if (conn?.locationName && !conn.needsReconnect) {
      const items = await google.fetchReviews(conn.accountName, conn.locationName, { sinceMs: conn.watermark || 0 });
      summary.fetched = items.length;
      if (items.length) {
        if (!conn.watermark) await clearDemoData();
        summary.newReviews = await upsertGoogleReviews(items);
        const newest = Math.max(...items.map((i) => i.updatedAt || 0));
        const latest = (await getGoogleConnection()) || conn;
        await setSetting('google', { ...latest, watermark: Math.max(latest.watermark || 0, newest) });
      }
    } else if (manual && (await isDemoMode())) {
      if (await addIncomingDemoReview()) summary.newReviews = 1;
    }
    await processPending(summary);
  } catch (err) {
    summary.errors.push(err.message);
  } finally {
    summary.finishedAt = Date.now();
    summary.ok = summary.errors.length === 0;
    await setSetting('lastSync', summary);
    await releaseLock('sync');
  }
  if (manual) await audit(user, 'sync', `${summary.newReviews} new, ${summary.drafted} drafted, ${summary.autoPosted} auto-posted`);
  return summary;
}
