// Sample reviews (from brand/demo.json) so the dashboard can be tried before Google is connected.
// They are marked source = 'demo' and removed automatically once a Google location syncs.
import { first, run, all } from './db.js';
import { brandDemo } from './brand.js';

const DAY = 86_400_000;
const DATA = {
  seed: brandDemo?.seed || [],
  incoming: brandDemo?.incoming || [],
  thing: brandDemo?.thing || 'your visit',
  signoff: brandDemo?.signoff || '- The team',
};

function cannedReply(name, stars) {
  const n = name === 'A Google User' ? '' : ` ${name.split(' ')[0]}`;
  const { thing, signoff } = DATA;
  if (stars >= 5) return `Thank you so much${n}! We're thrilled you enjoyed ${thing} and hope to see you again soon.\n${signoff}`;
  if (stars === 4) return `Thanks for the great review${n}! We're glad ${thing} worked well for you, and we've passed your feedback on to the team.\n${signoff}`;
  if (stars === 3) return `Thanks for the honest feedback${n}. We're always working to improve and hope we can earn five stars from you next time.\n${signoff}`;
  return `${n ? `Hi${n}, ` : ''}we're really sorry ${thing} fell short. That isn't the experience we want for anyone. Please reach out to us directly so we can make it right.\n${signoff}`;
}

const INSERT_JSON = `
INSERT INTO reviews (external_id, source, reviewer_name, star_rating, comment, created_at, updated_at, status,
                     suggested_reply, drafted_at, reply_text, reply_at, auto_approved, first_seen_at)
SELECT json_extract(j.value, '$.id'), 'demo', json_extract(j.value, '$.name'), json_extract(j.value, '$.stars'),
       json_extract(j.value, '$.text'), json_extract(j.value, '$.created'), json_extract(j.value, '$.created'),
       json_extract(j.value, '$.status'), json_extract(j.value, '$.reply'), json_extract(j.value, '$.drafted'),
       json_extract(j.value, '$.reply'), json_extract(j.value, '$.replyAt'), json_extract(j.value, '$.auto'),
       json_extract(j.value, '$.created')
FROM json_each(?) AS j WHERE true
ON CONFLICT(external_id) DO NOTHING`;

export async function seedDemoData() {
  const row = await first('SELECT COUNT(*) AS n FROM reviews');
  if (row.n > 0 || !DATA.seed.length) return false;
  const now = Date.now();
  const rows = DATA.seed.map(([name, stars, text, daysAgo, outcome], i) => {
    const created = now - daysAgo * DAY - ((i * 7919) % 36_000_000);
    const reply = outcome === 'pending' || outcome === 'skipped' ? null : cannedReply(name, stars);
    const delayH = outcome === 'auto' ? 0.3 + (i % 3) * 0.4 : outcome === 'replied' ? 30 + (i % 4) * 10 : 4 + (i % 5) * 6;
    return {
      id: `demo-${i + 1}`, name, stars, text, created,
      status: { pending: 'pending', auto: 'posted', manual: 'posted', replied: 'replied', skipped: 'skipped' }[outcome],
      reply, drafted: reply ? created : null, replyAt: reply ? Math.round(created + delayH * 3_600_000) : null,
      auto: outcome === 'auto' ? 1 : 0,
    };
  });
  await run(INSERT_JSON, JSON.stringify(rows)); // one statement for all rows
  return true;
}

export async function addIncomingDemoReview() {
  const used = new Set((await all("SELECT external_id FROM reviews WHERE external_id LIKE 'demo-in-%'")).map((r) => r.external_id));
  const idx = DATA.incoming.findIndex((_, i) => !used.has(`demo-in-${i}`));
  if (idx === -1) return null;
  const [name, stars, text] = DATA.incoming[idx];
  const now = Date.now();
  await run(`INSERT INTO reviews (external_id, source, reviewer_name, star_rating, comment, created_at, updated_at, status, first_seen_at)
             VALUES (?, 'demo', ?, ?, ?, ?, ?, 'pending', ?)`, `demo-in-${idx}`, name, stars, text, now, now, now);
  return name;
}

export async function clearDemoData() {
  return (await run("DELETE FROM reviews WHERE source = 'demo'")).changes;
}
