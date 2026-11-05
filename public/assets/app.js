(() => {
  'use strict';

  const { fmt } = window.Charts;
  const $ = (sel, root = document) => root.querySelector(sel);
  const MAX_REPLY = 4000;
  const BRAND = document.body.dataset;
  const TITLE = BRAND.brand === BRAND.app ? BRAND.app : `${BRAND.brand} ${BRAND.app}`;
  const store = {
    get: (k) => { try { return localStorage.getItem(`rra.${k}`); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(`rra.${k}`, v); } catch { /* ignore */ } },
  };

  const state = {
    me: null,
    csrf: null,
    status: null,
    view: null,
    reviews: { status: 'pending', stars: [], q: '', items: [], total: 0, counts: {}, offset: 0, loading: false },
    range: store.get('range') || '30',
  };

  // ---------- tiny helpers ----------

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'open') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const ICONS = {
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    alert: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    reply: '<path d="M10 8 5 12l5 4"/><path d="M5 12h9a5 5 0 0 1 5 5v1"/>',
    skip: '<circle cx="12" cy="12" r="9"/><path d="M7.5 16.5l9-9"/>',
    sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
    inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || ''; // static markup from the constant above, never user data
    return svg;
  }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
    const res = await fetch(`/api${path}`, {
      method, headers, credentials: 'same-origin', body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      window.location.href = '/login';
      throw new Error('Signed out');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
    return data;
  }

  function toast(message, type = 'info') {
    const el = h('div', { class: `toast ${type === 'error' ? 'error' : ''}`, role: type === 'error' ? 'alert' : 'status' }, message);
    $('#toasts').append(el);
    setTimeout(() => el.remove(), type === 'error' ? 7000 : 4000);
  }

  async function busy(btn, fn) {
    const original = [...btn.childNodes];
    btn.disabled = true;
    btn.replaceChildren(h('span', { class: 'spin', 'aria-hidden': 'true' }), ...original.filter((n) => n.nodeType === 3));
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.replaceChildren(...original);
    }
  }

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  function ago(ms) {
    if (!ms) return '';
    const diff = (ms - Date.now()) / 1000;
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [unit, sec] of units) if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), unit);
    return 'just now';
  }
  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const fullDate = (ms) => (ms ? dateFmt.format(new Date(ms)) : '');

  function initials(name) {
    const parts = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/);
    return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
  }

  function stars(n, size) {
    const wrap = h('span', { class: 'stars', role: 'img', 'aria-label': `${n || 0} out of 5 stars` });
    if (size) wrap.style.fontSize = size;
    for (let i = 1; i <= 5; i++) wrap.append(h('span', { class: i <= (n || 0) ? '' : 'off', 'aria-hidden': 'true' }, '★'));
    return wrap;
  }

  function avatar(name, photo) {
    const el = h('div', { class: 'avatar', 'aria-hidden': 'true' });
    if (photo && /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(photo)) {
      const img = h('img', { src: photo, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
      img.addEventListener('error', () => el.replaceChildren(initials(name)));
      el.append(img);
    } else {
      el.textContent = initials(name);
    }
    return el;
  }

  // ---------- shell ----------

  async function boot() {
    try {
      const me = await api('/auth/me');
      state.me = me.user;
      state.csrf = me.csrfToken;
    } catch {
      return;
    }
    $('#me-email').textContent = state.me.email;
    $('#me-avatar').textContent = initials(state.me.email);
    $('#logout-btn').addEventListener('click', async () => {
      try { await api('/auth/logout', { method: 'POST' }); } finally { window.location.href = '/login'; }
    });
    const shell = $('#shell');
    $('#menu-btn').addEventListener('click', () => {
      const open = shell.classList.toggle('nav-open');
      $('#menu-btn').setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') shell.classList.remove('nav-open'); });
    window.addEventListener('hashchange', route);
    await refreshStatus();
    route();
    setInterval(refreshStatus, 60_000);
  }

  async function refreshStatus() {
    try {
      state.status = await api('/status');
    } catch {
      return;
    }
    const n = state.status.pendingCount;
    const badge = $('#nav-pending');
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', !n);
    badge.setAttribute('aria-label', `${n} awaiting reply`);
    renderBanners();
  }

  function renderBanners() {
    const s = state.status;
    const box = $('#banners');
    box.replaceChildren();
    const add = (type, ic, ...content) => box.append(h('div', { class: `banner ${type}` }, icon(ic), h('div', {}, ...content)));
    if (s.google.needsReconnect) add('error', 'alert', 'Google access expired or was revoked. ', h('a', { href: '#settings' }, 'Reconnect Google'));
    else if (s.google.connected && !s.google.locationName) add('warn', 'alert', 'Google is connected. ', h('a', { href: '#settings' }, 'Choose which business location to manage'), '.');
    if (s.demoMode) add('info', 'info', h('b', {}, 'Demo mode. '), 'These are sample reviews; approving them doesn\'t post anything to Google. ', h('a', { href: '#settings' }, 'Connect Google'), ' to load your real reviews.');
    if (!s.openai.configured) add('warn', 'alert', 'Add your OpenAI API key to start drafting replies. ', h('a', { href: '#settings' }, 'Open settings'));
  }

  const VIEWS = { reviews: renderReviews, analytics: renderAnalytics, settings: renderSettings, account: renderAccount };

  function route() {
    const [name, query] = window.location.hash.slice(1).split('?');
    const view = VIEWS[name] ? name : 'reviews';
    state.view = view;
    document.querySelectorAll('.nav a').forEach((a) => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    $('#shell').classList.remove('nav-open');
    window.Charts.hideTip();
    const root = $('#view');
    root.replaceChildren();
    document.title = `${{ reviews: 'Reviews', analytics: 'Analytics', settings: 'Settings', account: 'Team & security' }[view]} · ${TITLE}`;
    VIEWS[view](root, new URLSearchParams(query || ''));
  }

  // =====================================================================
  // Reviews
  // =====================================================================

  const TABS = [
    ['pending', 'Needs reply'],
    ['posted', 'Posted'],
    ['replied', 'Replied on Google'],
    ['skipped', 'Skipped'],
    ['all', 'All'],
  ];

  function renderReviews(root) {
    const r = state.reviews;
    const s = state.status;
    const subtitle = s.demoMode ? `Sample data · ${document.body.dataset.business}` : (s.google.locationTitle || s.businessName || 'Google reviews');

    const autoText = s.autoApprove.enabled
      ? `Auto-approve on: ${s.autoApprove.stars.map((n) => `${n}★`).join(', ')}`
      : 'Auto-approve off';
    const syncInfo = h('span', { class: 'muted small', id: 'sync-info' });
    const syncBtn = h('button', { class: 'btn', type: 'button' }, icon('refresh'), 'Sync now');
    syncBtn.addEventListener('click', () => busy(syncBtn, doSync));

    const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Filter by status' });
    for (const [key, label] of TABS) {
      const tab = h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(r.status === key) },
        label, h('span', { class: 'n', 'data-count': key }));
      tab.addEventListener('click', () => {
        r.status = key;
        tabs.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
        loadReviews(true);
      });
      tabs.append(tab);
    }

    const chips = h('div', { class: 'filters' });
    for (const n of [5, 4, 3, 2, 1]) {
      const chip = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(r.stars.includes(n)), 'aria-label': `${n} star reviews` },
        String(n), h('span', { class: 's', 'aria-hidden': 'true' }, '★'));
      chip.addEventListener('click', () => {
        r.stars = r.stars.includes(n) ? r.stars.filter((x) => x !== n) : [...r.stars, n];
        chip.setAttribute('aria-pressed', String(r.stars.includes(n)));
        loadReviews(true);
      });
      chips.append(chip);
    }
    const search = h('input', { class: 'input search', type: 'search', placeholder: 'Search reviews…', 'aria-label': 'Search reviews', value: r.q });
    let t;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { r.q = search.value.trim(); loadReviews(true); }, 300);
    });
    chips.append(search);

    root.append(
      h('div', { class: 'view-head' },
        h('div', {}, h('h1', {}, 'Reviews'), h('p', { class: 'sub' }, subtitle)),
        h('div', { class: 'head-actions' },
          h('a', { class: 'chip', href: '#settings', title: 'Change auto-approve settings' }, icon('bolt'), autoText),
          syncInfo, syncBtn)),
      h('div', { id: 'sync-problems' }),
      h('div', { class: 'toolbar' }, tabs, chips),
      h('div', { class: 'review-list', id: 'review-list', 'aria-live': 'polite' }),
      h('div', { class: 'load-more', id: 'load-more' }),
    );
    renderSyncInfo();
    loadReviews(true);
  }

  function renderSyncInfo() {
    const el = $('#sync-info');
    if (!el) return;
    const last = state.status.lastSync;
    el.textContent = last ? `Synced ${ago(last.finishedAt)}` : 'Not synced yet';
    if (last) el.title = fullDate(last.finishedAt);
    const box = $('#sync-problems');
    box.replaceChildren();
    if (last && last.errors?.length) {
      box.append(h('div', { class: 'banner warn' }, icon('alert'), h('div', {}, h('b', {}, 'Last sync: '), [...new Set(last.errors)].join(' '))));
    }
  }

  async function doSync() {
    try {
      const { summary } = await api('/sync', { method: 'POST' });
      const bits = [];
      bits.push(summary.newReviews ? `${summary.newReviews} new review${summary.newReviews > 1 ? 's' : ''}` : 'No new reviews');
      if (summary.drafted) bits.push(`${summary.drafted} drafted`);
      if (summary.autoPosted) bits.push(`${summary.autoPosted} auto-posted`);
      toast(bits.join(' · '), summary.ok ? 'info' : 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
    await refreshStatus();
    renderSyncInfo();
    await loadReviews(true);
  }

  async function loadReviews(reset) {
    const r = state.reviews;
    const list = $('#review-list');
    if (!list) return;
    if (reset) { r.offset = 0; r.items = []; }
    const qs = new URLSearchParams({ status: r.status, limit: '20', offset: String(r.offset) });
    if (r.stars.length) qs.set('stars', r.stars.join(','));
    if (r.q) qs.set('q', r.q);
    const token = (r.reqToken = (r.reqToken || 0) + 1);
    let data;
    try {
      data = await api(`/reviews?${qs}`);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (token !== r.reqToken) return; // a newer request superseded this one
    if (reset) list.replaceChildren();
    r.items.push(...data.reviews);
    r.total = data.total;
    r.counts = data.counts;
    r.offset += data.reviews.length;
    for (const rv of data.reviews) list.append(reviewCard(rv));
    if (!r.items.length) list.append(emptyState());
    updateCounts();
    const more = $('#load-more');
    more.replaceChildren();
    if (r.offset < r.total) {
      const btn = h('button', { class: 'btn', type: 'button' }, `Load more (${r.total - r.offset} left)`);
      btn.addEventListener('click', () => busy(btn, () => loadReviews(false)));
      more.append(btn);
    }
  }

  function updateCounts() {
    const c = state.reviews.counts || {};
    document.querySelectorAll('[data-count]').forEach((el) => { el.textContent = c[el.dataset.count] ?? ''; });
  }

  function emptyState() {
    const r = state.reviews;
    const filtered = r.stars.length || r.q;
    const title = filtered ? 'No matching reviews' : r.status === 'pending' ? 'You\'re all caught up' : 'Nothing here yet';
    const text = filtered ? 'Try clearing the star or search filters.' : r.status === 'pending' ? 'New reviews will appear here with a drafted reply.' : 'Reviews will show up here once they reach this state.';
    return h('div', { class: 'card empty-state' }, icon(r.status === 'pending' && !filtered ? 'check' : 'inbox'), h('h3', {}, title), h('p', {}, text));
  }

  function statusBadge(rv) {
    const map = {
      pending: ['pending', 'clock', 'Needs reply'],
      posting: ['pending', 'clock', 'Posting…'],
      failed: ['failed', 'alert', 'Post failed'],
      posted: rv.autoApproved ? ['auto', 'bolt', 'Auto-approved'] : ['posted', 'check', 'Posted'],
      replied: ['replied', 'reply', 'Replied on Google'],
      skipped: ['skipped', 'skip', 'Skipped'],
    };
    const [cls, ic, label] = map[rv.status] || map.pending;
    return h('span', { class: `badge ${cls}` }, icon(ic), label);
  }

  function replaceCard(card, rv) {
    const next = reviewCard(rv);
    card.replaceWith(next);
    return next;
  }

  function reviewCard(rv) {
    const card = h('article', { class: 'card review', 'aria-label': `Review by ${rv.reviewerName}` });
    const head = h('div', { class: 'rv-head' },
      avatar(rv.reviewerName, rv.reviewerPhoto),
      h('div', { class: 'rv-who' },
        h('div', { class: 'rv-name' }, rv.reviewerName),
        h('div', { class: 'rv-meta' }, stars(rv.starRating), h('span', { title: fullDate(rv.createdAt) }, ago(rv.createdAt)))),
      statusBadge(rv));
    card.append(head);
    card.append(rv.comment
      ? h('p', { class: 'rv-text' }, rv.comment)
      : h('p', { class: 'rv-text empty' }, 'No written review, rating only.'));

    const open = rv.status === 'pending' || rv.status === 'failed';
    if (open) card.append(replyEditor(card, rv));
    else if (rv.replyText) {
      const who = rv.status === 'replied' ? 'Replied directly on Google'
        : rv.autoApproved ? 'Auto-approved' : `Posted${rv.postedBy ? ` by ${rv.postedBy}` : ''}`;
      card.append(h('div', { class: 'rv-reply' },
        h('div', { class: 'rv-reply-label' }, h('span', {}, 'Your reply'), h('span', { class: 'muted', title: fullDate(rv.replyAt) }, `${who} · ${ago(rv.replyAt)}`)),
        h('div', { class: 'rv-posted' }, rv.replyText)));
    }
    if (rv.status === 'skipped') {
      const undo = h('button', { class: 'btn sm', type: 'button' }, 'Move back to Needs reply');
      undo.addEventListener('click', () => busy(undo, async () => {
        try {
          const { review } = await api(`/reviews/${rv.id}/restore`, { method: 'POST' });
          replaceCard(card, review);
          refreshStatus();
        } catch (err) { toast(err.message, 'error'); }
      }));
      card.append(h('div', { class: 'rv-actions' }, undo));
    }
    return card;
  }

  function replyEditor(card, rv) {
    const wrap = h('div', { class: 'rv-reply' });
    if (!rv.suggestedReply) {
      const gen = h('button', { class: 'btn primary', type: 'button' }, icon('sparkle'), 'Draft a reply');
      gen.addEventListener('click', () => busy(gen, async () => {
        try {
          const { review } = await api(`/reviews/${rv.id}/generate`, { method: 'POST' });
          replaceCard(card, review).querySelector('textarea')?.focus();
        } catch (err) { toast(err.message, 'error'); }
      }));
      const skip = skipButton(card, rv);
      wrap.append(
        h('div', { class: 'rv-reply-label' }, h('span', {}, 'No reply drafted yet')),
        h('div', { class: 'rv-actions' }, gen, skip),
      );
      if (rv.error) wrap.append(h('p', { class: 'rv-error', role: 'alert' }, rv.error));
      return wrap;
    }

    const id = `reply-${rv.id}`;
    const ta = h('textarea', { id, rows: '4', maxlength: String(MAX_REPLY), value: rv.suggestedReply });
    const counter = h('span', { class: 'muted small' });
    const updateCounter = () => { counter.textContent = `${ta.value.length} / ${MAX_REPLY}`; };
    updateCounter();
    let saved = rv.suggestedReply;
    ta.addEventListener('input', updateCounter);
    ta.addEventListener('blur', async () => {
      if (ta.value === saved) return;
      try {
        await api(`/reviews/${rv.id}`, { method: 'PATCH', body: { suggestedReply: ta.value } });
        saved = ta.value;
      } catch (err) { toast(`Couldn't save your edit: ${err.message}`, 'error'); }
    });

    const approve = h('button', { class: 'btn primary', type: 'button' }, icon('check'), rv.status === 'failed' ? 'Retry posting' : 'Approve & post');
    approve.addEventListener('click', () => busy(approve, async () => {
      if (!ta.value.trim()) { toast('The reply is empty.', 'error'); return; }
      try {
        const { review } = await api(`/reviews/${rv.id}/approve`, { method: 'POST', body: { reply: ta.value } });
        replaceCard(card, review);
        toast(state.status.demoMode ? 'Reply approved (demo: nothing was posted).' : 'Reply posted to Google.');
        refreshStatus();
        bumpCount('pending', -1); bumpCount('posted', 1);
      } catch (err) {
        toast(err.message, 'error');
        await loadReviews(true); // show the review's real state (e.g. failed, or already handled)
      }
    }));

    const regen = h('button', { class: 'btn', type: 'button' }, icon('refresh'), 'Regenerate');
    regen.addEventListener('click', () => busy(regen, async () => {
      try {
        const { review } = await api(`/reviews/${rv.id}/generate`, { method: 'POST' });
        replaceCard(card, review);
      } catch (err) { toast(err.message, 'error'); }
    }));

    wrap.append(
      h('label', { class: 'rv-reply-label', for: id }, h('span', {}, 'Suggested reply'), h('span', { class: 'ai-chip' }, 'AI draft')),
      ta,
      h('div', { class: 'rv-actions' }, approve, regen, skipButton(card, rv), h('span', { class: 'grow' }), counter),
    );
    if (rv.status === 'failed' && rv.error) wrap.append(h('p', { class: 'rv-error', role: 'alert' }, `Posting failed: ${rv.error}`));
    return wrap;
  }

  function skipButton(card, rv) {
    const skip = h('button', { class: 'btn ghost', type: 'button' }, 'Skip');
    skip.addEventListener('click', () => busy(skip, async () => {
      try {
        const { review } = await api(`/reviews/${rv.id}/skip`, { method: 'POST' });
        if (state.reviews.status === 'pending') card.remove();
        else replaceCard(card, review);
        bumpCount('pending', -1); bumpCount('skipped', 1);
        refreshStatus();
        if (!$('#review-list').children.length) $('#review-list').append(emptyState());
      } catch (err) { toast(err.message, 'error'); }
    }));
    return skip;
  }

  function bumpCount(key, delta) {
    const c = state.reviews.counts;
    if (c && c[key] != null) c[key] = Math.max(0, c[key] + delta);
    updateCounts();
  }

  // =====================================================================
  // Analytics
  // =====================================================================

  const RANGES = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', '12 months'], ['all', 'All time']];

  function renderAnalytics(root) {
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Date range' });
    for (const [key, label] of RANGES) {
      const b = h('button', { type: 'button', 'aria-pressed': String(state.range === key) }, label);
      b.addEventListener('click', () => {
        state.range = key;
        store.set('range', key);
        seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        load();
      });
      seg.append(b);
    }
    const body = h('div', { class: 'analytics' });
    root.append(
      h('div', { class: 'view-head' },
        h('div', {}, h('h1', {}, 'Analytics'), h('p', { class: 'sub' }, 'Review trends, reply performance and OpenAI spend.')),
        seg),
      body,
    );

    let data = null;
    async function load() {
      body.classList.add('is-loading');
      try {
        data = await api(`/analytics?range=${encodeURIComponent(state.range)}&tz=${new Date().getTimezoneOffset()}`);
        draw();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        body.classList.remove('is-loading');
      }
    }

    let lastWidth = 0;
    const ro = new ResizeObserver(() => {
      const w = body.clientWidth;
      if (data && Math.abs(w - lastWidth) > 4) { lastWidth = w; draw(); }
    });
    ro.observe(body);
    const stop = () => { ro.disconnect(); window.removeEventListener('hashchange', stop); };
    window.addEventListener('hashchange', stop);

    function draw() {
      lastWidth = body.clientWidth;
      body.replaceChildren(...analyticsContent(data));
      // charts need to be in the DOM to measure
      body.querySelectorAll('[data-draw]').forEach((el) => el._draw && el._draw());
    }
    load();
  }

  function periodLabel(key, granularity, long = false) {
    const d = new Date(key);
    if (granularity === 'month') return d.toLocaleDateString(undefined, { month: long ? 'long' : 'short', year: long ? 'numeric' : '2-digit', timeZone: 'UTC' });
    const s = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC', ...(long ? { year: 'numeric' } : {}) });
    return granularity === 'week' && long ? `Week of ${s}` : s;
  }

  function hoursLabel(h) {
    if (h == null) return '—';
    if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
    if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
    return `${(h / 24).toFixed(1)} days`;
  }

  function tile(label, value, deltaEl, unit) {
    return h('div', { class: 'card tile' },
      h('div', { class: 'label' }, label),
      h('div', { class: 'value' }, value, unit ? h('span', { class: 'unit' }, unit) : null),
      h('div', { class: 'delta' }, deltaEl || ' '));
  }

  function delta(curr, prev, { kind = 'pct', upIsGood = true, label }) {
    if (prev == null || curr == null) return null;
    let diff, text;
    if (kind === 'pct') {
      if (!prev) return h('span', {}, `No data in previous ${label}`);
      diff = (curr - prev) / prev;
      text = `${Math.abs(diff * 100).toFixed(0)}%`;
    } else if (kind === 'pts') {
      diff = curr - prev;
      text = `${Math.abs(diff * 100).toFixed(0)} pts`;
    } else {
      diff = curr - prev;
      text = kind === 'hours' ? hoursLabel(Math.abs(diff)) : Math.abs(diff).toFixed(2);
    }
    if (Math.abs(diff) < 1e-9) return h('span', {}, `No change vs previous ${label}`);
    const up = diff > 0;
    const good = up === upIsGood;
    return h('span', {}, h('span', { class: `${up ? 'up' : 'down'}-${good ? 'good' : 'bad'}` }, `${up ? '▲' : '▼'} ${text}`), ` vs previous ${label}`);
  }

  function chartCard(title, subtitle, drawFn, tableEl, wide) {
    const chart = h('div', { class: 'chart', 'data-draw': '' });
    chart._draw = () => drawFn(chart);
    return h('section', { class: `card chart-card ${wide ? 'wide' : ''}` },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, title), subtitle ? h('p', {}, subtitle) : null)),
      chart,
      tableEl);
  }

  function analyticsContent(d) {
    const { reviews: rv, previous: prev, costs, series, range } = d;
    const g = range.granularity;
    const rangeLabel = range.key === 'all' ? '' : `${range.key} days`;
    const per = { day: 'day', week: 'week', month: 'month' }[g];
    const C = window.Charts;

    // --- Reviews tiles
    const reviewTiles = h('div', { class: 'tiles' },
      tile('Reviews', fmt.int(rv.total), prev && delta(rv.total, prev.total, { label: rangeLabel })),
      tile('Average rating', rv.avgRating == null ? '—' : rv.avgRating.toFixed(2), prev && delta(rv.avgRating, prev.avgRating, { kind: 'abs', label: rangeLabel }), rv.avgRating == null ? '' : ' ★'),
      tile('Response rate', fmt.pct(rv.responseRate), prev && delta(rv.responseRate, prev.responseRate, { kind: 'pts', label: rangeLabel })),
      tile('Median time to reply', hoursLabel(rv.medianReplyHours), prev && delta(rv.medianReplyHours, prev.medianReplyHours, { kind: 'hours', upIsGood: false, label: rangeLabel })),
    );

    const total = rv.total || 0;
    const distData = rv.distribution.map((x) => ({
      label: `${x.stars} ★`,
      value: x.count,
      valueLabel: `${fmt.int(x.count)}${total ? ` · ${fmt.pct(x.count / total)}` : ''}`,
      rows: [[fmt.int(x.count), `reviews · ${total ? fmt.pct(x.count / total, 1) : '0%'}`]],
    }));
    const distCard = chartCard('Rating distribution', `${fmt.int(total)} reviews in this period`,
      (el) => C.hbars(el, { data: distData, ariaLabel: 'Rating distribution' }),
      C.table([{ label: 'Rating' }, { label: 'Reviews', num: true }, { label: 'Share', num: true }],
        rv.distribution.map((x) => [`${x.stars} stars`, fmt.int(x.count), total ? fmt.pct(x.count / total, 1) : '—'])));

    const b = rv.breakdown;
    const parts = [
      { name: 'Auto-approved', value: b.auto, k: 1 },
      { name: 'Approved by you', value: b.manual, k: 2 },
      { name: 'Replied on Google', value: b.external, k: 3 },
      { name: 'Awaiting reply', value: b.awaiting, k: 4 },
      { name: 'Skipped', value: b.skipped, k: 5 },
    ];
    const statusCard = chartCard('Reply status', 'How reviews from this period were handled',
      (el) => C.segmented(el, { parts, ariaLabel: 'Reply status breakdown' }),
      C.table([{ label: 'Status' }, { label: 'Reviews', num: true }, { label: 'Share', num: true }],
        parts.map((p) => [p.name, fmt.int(p.value), total ? fmt.pct(p.value / total, 1) : '—'])));

    const volData = series.map((x) => ({
      label: periodLabel(x.key, g), title: periodLabel(x.key, g, true), value: x.reviews,
      rows: [[fmt.int(x.reviews), x.reviews === 1 ? 'review' : 'reviews', 1], ...(x.avgRating != null ? [[`${x.avgRating.toFixed(2)} ★`, 'average', false]] : [])],
    }));
    const volCard = chartCard('New reviews', `Per ${per}`,
      (el) => C.columns(el, { data: volData, integer: true, ariaLabel: `New reviews per ${per}` }),
      C.table([{ label: g === 'week' ? 'Week of' : g === 'month' ? 'Month' : 'Day' }, { label: 'Reviews', num: true }, { label: 'Avg rating', num: true }],
        series.map((x) => [periodLabel(x.key, g, true), fmt.int(x.reviews), x.avgRating == null ? '—' : x.avgRating.toFixed(2)])));

    const ratingData = series.map((x) => ({
      label: periodLabel(x.key, g), title: periodLabel(x.key, g, true), value: x.avgRating,
      rows: [[x.avgRating == null ? 'No reviews' : `${x.avgRating.toFixed(2)} ★`, x.avgRating == null ? '' : `from ${x.reviews} review${x.reviews === 1 ? '' : 's'}`]],
    }));
    const ratingCard = chartCard('Average rating', `Per ${per} · gaps mean no reviews that ${per}`,
      (el) => C.line(el, { data: ratingData, yMin: 1, yMax: 5, format: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)), ariaLabel: `Average rating per ${per}`, emptyLabel: 'No reviews in this period' }),
      null);

    // --- Cost tiles
    const costTiles = h('div', { class: 'tiles' },
      tile('AI spend', fmt.money(costs.costUsd), prev && delta(costs.costUsd, prev.costUsd, { upIsGood: false, label: rangeLabel })),
      tile('Cost per posted reply', fmt.money(costs.costPerReply), h('span', {}, `${fmt.int(costs.repliesPosted)} replies posted`)),
      tile('This month so far', fmt.money(costs.monthToDateUsd), h('span', {}, `All time ${fmt.money(costs.allTimeUsd)}`)),
      tile('Projected per month', fmt.money(costs.projectedMonthlyUsd), h('span', {}, 'Based on the last 30 days')),
    );

    const spendData = series.map((x) => ({
      label: periodLabel(x.key, g), title: periodLabel(x.key, g, true), value: x.costUsd,
      rows: [[fmt.money(x.costUsd), 'spend', 1], [fmt.int(x.requests), x.requests === 1 ? 'request' : 'requests', false], [fmt.compact(x.inputTokens + x.outputTokens), 'tokens', false]],
    }));
    const spendCard = chartCard('OpenAI spend', `Estimated cost per ${per}`,
      (el) => C.columns(el, { data: spendData, format: fmt.money, axisFormat: fmt.moneyAxis, ariaLabel: `OpenAI spend per ${per}` }),
      C.table([{ label: g === 'week' ? 'Week of' : g === 'month' ? 'Month' : 'Day' }, { label: 'Spend', num: true }, { label: 'Requests', num: true }, { label: 'Input tokens', num: true }, { label: 'Output tokens', num: true }],
        series.map((x) => [periodLabel(x.key, g, true), fmt.money(x.costUsd), fmt.int(x.requests), fmt.int(x.inputTokens), fmt.int(x.outputTokens)])),
      true);

    const usageCard = h('section', { class: 'card chart-card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Usage'), h('p', {}, 'Requests and tokens in this period'))),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Requests'), h('dd', {}, `${fmt.int(costs.requests)}${costs.failed ? ` (${fmt.int(costs.failed)} failed)` : ''}`),
        h('dt', {}, 'Input tokens'), h('dd', {}, `${fmt.int(costs.inputTokens)}${costs.cachedTokens ? ` (${fmt.int(costs.cachedTokens)} cached)` : ''}`),
        h('dt', {}, 'Output tokens'), h('dd', {}, fmt.int(costs.outputTokens)),
        h('dt', {}, 'Avg cost / request'), h('dd', {}, fmt.money(costs.avgCostPerRequest)),
      ),
      costs.byPurpose.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Purpose'), h('th', { class: 'num' }, 'Requests'), h('th', { class: 'num' }, 'Spend'))),
        h('tbody', {}, costs.byPurpose.map((p) => h('tr', {},
          h('td', {}, { draft: 'Drafts for new reviews', regenerate: 'Regenerated drafts', preview: 'Settings previews' }[p.purpose] || p.purpose),
          h('td', { class: 'num' }, fmt.int(p.requests)), h('td', { class: 'num' }, fmt.money(p.costUsd))))))) : null,
    );

    const modelCard = h('section', { class: 'card chart-card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Cost by model'))),
      costs.byModel.length
        ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Model'), h('th', { class: 'num' }, 'Requests'), h('th', { class: 'num' }, 'Tokens'), h('th', { class: 'num' }, 'Spend'))),
          h('tbody', {}, costs.byModel.map((m) => h('tr', {},
            h('td', {}, h('code', {}, m.model)),
            h('td', { class: 'num' }, fmt.int(m.requests)),
            h('td', { class: 'num' }, fmt.compact(m.inputTokens + m.outputTokens)),
            h('td', { class: 'num' }, fmt.money(m.costUsd)))))))
        : h('p', { class: 'muted' }, 'No OpenAI requests in this period.'),
      costs.recentErrors.length ? h('div', { class: 'callout warn' }, h('b', {}, 'Recent errors: '), costs.recentErrors.map((e) => e.error).filter((v, i, a) => a.indexOf(v) === i).join(' · ')) : null,
    );

    const notes = [
      'Costs are estimates from token counts × the per-model prices in Settings. Your OpenAI invoice is the source of truth.',
    ];
    if (costs.unpriced) notes.push(`${costs.unpriced} request${costs.unpriced > 1 ? 's have' : ' has'} no price set for its model, so they count as $0. Add prices in Settings.`);

    return [
      h('div', { class: 'section-title' }, h('h2', {}, 'Reviews')),
      reviewTiles,
      h('div', { class: 'charts' }, distCard, statusCard, volCard, ratingCard),
      h('div', { class: 'section-title' }, h('h2', {}, 'OpenAI API costs'), h('a', { href: '#settings', class: 'small' }, 'Edit model & prices')),
      costTiles,
      h('div', { class: 'charts' }, spendCard, usageCard, modelCard),
      h('p', { class: 'cost-note' }, notes.join(' ')),
    ];
  }

  // =====================================================================
  // Settings
  // =====================================================================

  const TONE_LABELS = { friendly: 'Friendly', professional: 'Professional', warm: 'Warm', concise: 'Concise', playful: 'Playful' };
  const LENGTH_LABELS = { short: 'Short (1–2 sentences)', medium: 'Medium (2–4 sentences)', long: 'Longer (a short paragraph)' };

  async function renderSettings(root, params) {
    root.append(h('div', { class: 'view-head' }, h('div', {}, h('h1', {}, 'Settings'), h('p', { class: 'sub' }, 'Auto-approve rules, reply style, OpenAI and Google connection.'))));
    const g = params.get('google');
    if (g) {
      const msgs = { connected: ['Google connected. Now choose a location below.', 'info'], denied: ['Google access was not granted.', 'error'], state_error: ['The Google sign-in expired. Try connecting again.', 'error'], error: ['Connecting Google failed. Check the server log.', 'error'] };
      if (msgs[g]) toast(...msgs[g]);
      history.replaceState(null, '', '#settings');
      refreshStatus();
    }
    let data;
    try {
      data = await api('/settings');
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (state.view !== 'settings') return;
    root.append(settingsForm(data));
  }

  function settingsForm(data) {
    const s = structuredClone(data.settings);
    const opts = data.options;
    const container = h('div', { class: 'settings-grid' });
    const saveBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Save changes');
    const saveNote = h('span', { class: 'muted small' }, 'All changes saved');
    let dirty = false;
    const markDirty = () => { dirty = true; saveBtn.disabled = false; saveNote.textContent = 'You have unsaved changes'; };

    const bind = (el, key, transform = (v) => v) => {
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
        s[key] = transform(el.type === 'checkbox' ? el.checked : el.value);
        markDirty();
      });
      return el;
    };

    // --- Auto-approve
    const autoSwitch = h('input', { type: 'checkbox', checked: s.autoApprove.enabled, id: 'auto-enabled' });
    const matchNote = h('div', { class: 'callout' });
    const picks = h('div', { class: 'star-picks', role: 'group', 'aria-label': 'Ratings to auto-approve' });
    const updateMatch = () => {
      const n = s.autoApprove.stars.reduce((sum, st) => sum + (data.pendingByStars[st] || 0), 0);
      matchNote.className = `callout ${s.autoApprove.enabled && n ? 'warn' : ''}`;
      if (!s.autoApprove.enabled) matchNote.textContent = 'Off. Every reply waits for someone to approve it.';
      else if (!s.autoApprove.stars.length) matchNote.textContent = 'Pick at least one rating.';
      else {
        matchNote.textContent = `Replies to new ${s.autoApprove.stars.map((x) => `${x}★`).join(', ')} reviews will be drafted and posted automatically on each sync.`
          + (n ? ` ${n} review${n > 1 ? 's' : ''} waiting right now match${n > 1 ? '' : 'es'} and will be posted on the next sync.` : '');
      }
    };
    autoSwitch.addEventListener('change', () => { s.autoApprove.enabled = autoSwitch.checked; markDirty(); updateMatch(); });
    for (const n of [5, 4, 3, 2, 1]) {
      const cb = h('input', { type: 'checkbox', checked: s.autoApprove.stars.includes(n) });
      cb.addEventListener('change', () => {
        s.autoApprove.stars = cb.checked ? [...s.autoApprove.stars, n].sort((a, b) => b - a) : s.autoApprove.stars.filter((x) => x !== n);
        markDirty(); updateMatch();
      });
      picks.append(h('label', { class: 'star-pick' }, cb, `${n}`, h('span', { class: 's', 'aria-hidden': 'true' }, '★'), h('span', { class: 'sr-only' }, ' stars')));
    }
    updateMatch();
    container.append(h('section', { class: 'card card-pad' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Auto-approve'), h('p', {}, 'Post AI replies without review for the ratings you pick. Other ratings always wait for you.'))),
      h('label', { class: 'switch', for: 'auto-enabled' }, autoSwitch, h('span', {}, 'Automatically post replies for these ratings')),
      picks,
      matchNote,
      h('p', { class: 'field-hint' }, 'Tip: most businesses auto-approve 4★ and 5★ and keep 1–3★ for a person to handle.'),
    ));

    // --- Reply style
    const toneSel = bind(h('select', { id: 'tone' }, opts.tones.map((t) => h('option', { value: t, selected: s.tone === t }, TONE_LABELS[t] || t))), 'tone');
    const lenSel = bind(h('select', { id: 'len' }, opts.lengths.map((l) => h('option', { value: l, selected: s.replyLength === l }, LENGTH_LABELS[l] || l))), 'replyLength');
    const autoDraft = bind(h('input', { type: 'checkbox', checked: s.autoDraft, id: 'auto-draft' }), 'autoDraft');
    const previewStars = h('select', { 'aria-label': 'Sample rating' }, [5, 4, 3, 2, 1].map((n) => h('option', { value: n }, `${n} ★`)));
    const previewText = h('textarea', { rows: '2', 'aria-label': 'Sample review text', placeholder: 'Sample review text…', value: 'Great coffee and super friendly staff, but it took a while to get a table on Saturday.' });
    const previewOut = h('div', { class: 'preview-out hidden', 'aria-live': 'polite' });
    const previewBtn = h('button', { class: 'btn', type: 'button' }, icon('sparkle'), 'Preview a reply');
    previewBtn.addEventListener('click', () => busy(previewBtn, async () => {
      try {
        const { reply } = await api('/settings/preview', {
          method: 'POST',
          body: {
            stars: previewStars.value, comment: previewText.value, businessName: s.businessName, tone: s.tone,
            replyLength: s.replyLength, signature: s.signature, customInstructions: s.customInstructions, openaiModel: s.openaiModel,
          },
        });
        previewOut.textContent = reply;
        previewOut.classList.remove('hidden');
      } catch (err) { toast(err.message, 'error'); }
    }));

    container.append(h('section', { class: 'card card-pad' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Reply style'), h('p', {}, 'Guides how the AI writes every reply.'))),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, h('span', {}, 'Business name'), bind(h('input', { class: 'input', value: s.businessName, maxlength: '120', placeholder: `e.g. ${document.body.dataset.business}` }), 'businessName')),
        h('label', { class: 'field' }, h('span', {}, 'Sign-off (optional)'), bind(h('input', { class: 'input', value: s.signature, maxlength: '120', placeholder: 'e.g. - Sam, Owner' }), 'signature')),
        h('label', { class: 'field', for: 'tone' }, h('span', {}, 'Tone'), toneSel),
        h('label', { class: 'field', for: 'len' }, h('span', {}, 'Length'), lenSel),
        h('label', { class: 'field full' }, h('span', {}, 'Extra instructions (optional)'),
          bind(h('textarea', { rows: '4', maxlength: '2000', value: s.customInstructions, placeholder: 'e.g. For complaints, ask them to email hello@example.com. Never mention prices. Mention our weekend brunch when relevant.' }), 'customInstructions'),
          h('div', { class: 'field-hint' }, 'Put contact details here if you want them in replies to complaints. The AI is told never to invent them.')),
        h('label', { class: 'switch full', for: 'auto-draft' }, autoDraft, h('span', {}, 'Draft replies automatically when new reviews arrive')),
      ),
      h('div', { class: 'callout' },
        h('div', { class: 'row' }, h('b', {}, 'Try it'), h('span', { class: 'muted small' }, 'Uses your current (unsaved) style. Costs one small API call.')),
        h('div', { class: 'row preview-row' }, previewStars, previewBtn),
        previewText,
        previewOut),
    ));
    previewStars.classList.add('input');
    previewStars.style.width = 'auto';
    previewText.style.marginTop = '8px';
    previewText.style.minHeight = '60px';

    // --- OpenAI
    const keyInput = h('input', { class: 'input', type: 'password', placeholder: 'sk-…', autocomplete: 'off', 'aria-label': 'OpenAI API key' });
    const keySave = h('button', { class: 'btn', type: 'button' }, 'Save key');
    const keyStatus = h('div', { class: 'status-line' });
    const keyBox = h('div', {});
    const renderKey = (o) => {
      keyStatus.replaceChildren(
        h('span', { class: `dot ${o.configured ? 'on' : 'off'}` }),
        o.configured
          ? (o.source === 'env' ? `Using the key from OPENAI_API_KEY (${o.hint})` : `Saved key ${o.hint} (encrypted on the server)`)
          : 'No API key yet',
      );
      keyBox.replaceChildren();
      if (o.source === 'env') {
        keyBox.append(h('p', { class: 'field-hint' }, 'To change it, edit OPENAI_API_KEY in the server environment and restart.'));
      } else {
        const row = h('div', { class: 'row' }, keyInput, keySave);
        keyInput.style.flex = '1';
        keyInput.style.minWidth = '200px';
        if (o.configured) {
          const rm = h('button', { class: 'btn ghost danger', type: 'button' }, 'Remove');
          rm.addEventListener('click', () => busy(rm, async () => {
            if (!confirm('Remove the saved OpenAI key? Drafting will stop until a new key is added.')) return;
            try { const res = await api('/settings/openai-key', { method: 'DELETE' }); renderKey(res.openai); refreshStatus(); toast('Key removed.'); } catch (err) { toast(err.message, 'error'); }
          }));
          row.append(rm);
        }
        keyBox.append(row, h('p', { class: 'field-hint' }, 'Create a key at platform.openai.com → API keys. It is stored encrypted and never sent back to the browser.'));
      }
    };
    keySave.addEventListener('click', () => busy(keySave, async () => {
      try {
        const res = await api('/settings/openai-key', { method: 'PUT', body: { apiKey: keyInput.value } });
        keyInput.value = '';
        renderKey(res.openai);
        refreshStatus();
        toast('OpenAI key saved.');
      } catch (err) { toast(err.message, 'error'); }
    }));
    renderKey(data.openai);

    const modelInput = h('input', { class: 'input', value: s.openaiModel, list: 'model-list', id: 'model', autocomplete: 'off', spellcheck: 'false' });
    const modelList = h('datalist', { id: 'model-list' }, opts.models.map((m) => h('option', { value: m })));
    const priceIn = h('input', { class: 'input', type: 'number', min: '0', step: '0.001', inputmode: 'decimal' });
    const priceCached = h('input', { class: 'input', type: 'number', min: '0', step: '0.001', inputmode: 'decimal' });
    const priceOut = h('input', { class: 'input', type: 'number', min: '0', step: '0.001', inputmode: 'decimal' });
    const priceHint = h('div', { class: 'field-hint' });
    const lookupPrice = (model) => {
      if (opts.savedPricing[model]) return opts.savedPricing[model];
      if (opts.defaultPricing[model]) return opts.defaultPricing[model];
      const prefix = Object.keys(opts.defaultPricing).filter((k) => model.startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0];
      return prefix ? opts.defaultPricing[prefix] : null;
    };
    const fillPrices = (p) => {
      priceIn.value = p ? p.input : '';
      priceCached.value = p ? (p.cachedInput ?? p.input) : '';
      priceOut.value = p ? p.output : '';
      priceHint.textContent = p
        ? 'USD per 1 million tokens. Check current prices at openai.com/api/pricing and adjust if needed.'
        : 'No known price for this model. Enter its prices so costs can be tracked.';
      s.modelPricing = p ? { ...p } : null;
    };
    fillPrices(s.modelPricing);
    modelInput.addEventListener('input', () => {
      s.openaiModel = modelInput.value.trim();
      fillPrices(lookupPrice(s.openaiModel));
      markDirty();
    });
    const onPrice = () => {
      s.modelPricing = { input: priceIn.value, cachedInput: priceCached.value || priceIn.value, output: priceOut.value };
      markDirty();
    };
    [priceIn, priceCached, priceOut].forEach((el) => el.addEventListener('input', onPrice));

    container.append(h('section', { class: 'card card-pad' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'OpenAI'), h('p', {}, 'Your key is used only on the server to draft replies.'))),
      h('div', { class: 'stack' },
        h('div', {}, h('div', { class: 'field-label' }, 'API key'), keyStatus, keyBox),
        h('div', { class: 'form-grid' },
          h('label', { class: 'field full', for: 'model' }, h('span', {}, 'Model'), modelInput, modelList,
            h('div', { class: 'field-hint' }, 'Pick from the list or type any model your key can use. Smaller "mini" models are plenty for review replies.')),
          h('label', { class: 'field' }, h('span', {}, 'Input price ($ / 1M tokens)'), priceIn),
          h('label', { class: 'field' }, h('span', {}, 'Output price ($ / 1M tokens)'), priceOut),
          h('label', { class: 'field' }, h('span', {}, 'Cached input price ($ / 1M tokens)'), priceCached),
          h('div', { class: 'full' }, priceHint),
        ),
      ),
    ));
    keyStatus.style.marginBottom = '8px';

    // --- Google
    container.append(googleCard(data.google));

    // --- Sync
    container.append(h('section', { class: 'card card-pad' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Sync'), h('p', {}, 'How often to check Google for new reviews, draft replies and run auto-approve.'))),
      h('label', { class: 'field' }, h('span', {}, 'Check every (minutes)'),
        bind(h('input', { class: 'input', type: 'number', min: '5', max: '1440', value: s.syncIntervalMinutes }), 'syncIntervalMinutes', Number)),
    ));
    container.lastChild.querySelector('input').style.maxWidth = '160px';

    // --- Save
    saveBtn.addEventListener('click', () => busy(saveBtn, async () => {
      try {
        const body = { ...s };
        if (!body.modelPricing || body.modelPricing.input === '' || body.modelPricing.output === '') delete body.modelPricing;
        const res = await api('/settings', { method: 'PUT', body });
        data.pendingByStars = res.pendingByStars;
        opts.savedPricing = res.options.savedPricing;
        dirty = false;
        saveNote.textContent = 'All changes saved';
        toast('Settings saved.');
        refreshStatus();
      } catch (err) { toast(err.message, 'error'); }
      saveBtn.disabled = !dirty;
    }));
    window.addEventListener('beforeunload', (e) => { if (dirty && state.view === 'settings') e.preventDefault(); });

    container.append(h('div', { class: 'save-bar' }, saveNote, saveBtn));
    return container;
  }

  function googleCard(g) {
    const card = h('section', { class: 'card card-pad' });
    const draw = (gs) => {
      card.replaceChildren(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Google Business Profile'), h('p', {}, 'Where reviews come from and replies are posted.'))));
      if (!gs.configured) {
        card.append(
          h('div', { class: 'status-line' }, h('span', { class: 'dot off' }), 'Not set up'),
          h('div', { class: 'callout' },
            h('p', {}, 'Add these to the server\'s environment (see README), then restart:'),
            h('p', {}, h('code', {}, 'GOOGLE_CLIENT_ID'), ' and ', h('code', {}, 'GOOGLE_CLIENT_SECRET')),
            h('p', {}, 'Authorized redirect URI to register in Google Cloud: ', h('code', {}, gs.redirectUri))),
        );
        return;
      }
      if (!gs.connected || gs.needsReconnect) {
        card.append(
          h('div', { class: 'status-line' }, h('span', { class: `dot ${gs.needsReconnect ? 'bad' : 'off'}` }), gs.needsReconnect ? 'Access expired, reconnect needed' : 'Not connected'),
          h('div', { class: 'row connect-row' }, h('a', { class: 'btn primary', href: '/api/google/connect' }, 'Connect Google account')),
          h('p', { class: 'field-hint' }, 'Sign in with the Google account that manages your business profile.'),
        );
        return;
      }
      const locBox = h('div', { class: 'stack' });
      const kv = h('dl', { class: 'kv' },
        h('dt', {}, 'Account'), h('dd', {}, gs.email || 'Connected'),
        h('dt', {}, 'Location'), h('dd', {}, gs.locationTitle || h('span', { class: 'muted' }, 'Not chosen yet')));
      const chooseBtn = h('button', { class: 'btn', type: 'button' }, gs.locationName ? 'Change location' : 'Choose location');
      chooseBtn.addEventListener('click', () => busy(chooseBtn, async () => {
        try {
          const { locations } = await api('/google/locations');
          if (!locations.length) { toast('No locations found on this Google account.', 'error'); return; }
          const sel = h('select', { 'aria-label': 'Business location' }, locations.map((l, i) =>
            h('option', { value: String(i), selected: l.locationName === gs.locationName }, `${l.title}${l.address ? ` — ${l.address}` : ''}`)));
          const use = h('button', { class: 'btn primary', type: 'button' }, 'Use this location');
          use.addEventListener('click', () => busy(use, async () => {
            const l = locations[Number(sel.value)];
            if (gs.locationName && gs.locationName !== l.locationName && !confirm('Switch location? Reviews from the current location will be cleared from this dashboard.')) return;
            try {
              const res = await api('/google/location', { method: 'POST', body: { accountName: l.accountName, locationName: l.locationName } });
              toast(`Now managing ${l.title}. Synced ${res.summary.fetched} reviews.`);
              await refreshStatus();
              draw(res.google);
            } catch (err) { toast(err.message, 'error'); }
          }));
          locBox.replaceChildren(h('div', { class: 'row' }, sel, use));
          sel.style.flex = '1';
        } catch (err) { toast(err.message, 'error'); }
      }));
      const disc = h('button', { class: 'btn ghost danger', type: 'button' }, 'Disconnect');
      disc.addEventListener('click', () => busy(disc, async () => {
        if (!confirm('Disconnect Google? Syncing and posting will stop until you reconnect.')) return;
        try { const res = await api('/google/disconnect', { method: 'POST' }); await refreshStatus(); draw(res.google); toast('Google disconnected.'); } catch (err) { toast(err.message, 'error'); }
      }));
      card.append(h('div', { class: 'status-line' }, h('span', { class: 'dot on' }), 'Connected'), kv, h('div', { class: 'row' }, chooseBtn, disc), locBox);
      card.querySelector('.kv').style.margin = '12px 0';
      locBox.style.marginTop = '12px';
    };
    draw(g);
    return card;
  }

  // =====================================================================
  // Team & security
  // =====================================================================

  const ACTIONS = {
    login: 'Signed in', logout: 'Signed out', login_failed: 'Failed sign-in', login_blocked: 'Sign-in blocked (too many attempts)',
    password_changed: 'Changed password', password_reset_cli: 'Password reset (command line)', '2fa_enabled': 'Turned on 2FA', '2fa_disabled': 'Turned off 2FA',
    user_created: 'Added user', user_removed: 'Removed user', reply_posted: 'Posted reply', reply_auto_posted: 'Auto-posted reply',
    reply_failed: 'Reply failed', review_skipped: 'Skipped review', settings_changed: 'Changed settings', auto_approve_changed: 'Changed auto-approve',
    openai_key_saved: 'Saved OpenAI key', openai_key_removed: 'Removed OpenAI key', google_connected: 'Connected Google',
    google_disconnected: 'Disconnected Google', google_location_selected: 'Chose Google location', sync: 'Synced reviews',
  };

  async function renderAccount(root) {
    root.append(h('div', { class: 'view-head' }, h('div', {}, h('h1', {}, 'Team & security'), h('p', { class: 'sub' }, 'Your password, two-factor authentication, team members and activity.'))));
    const grid = h('div', { class: 'settings-grid' });
    root.append(grid);
    grid.append(passwordCard(), twoFactorCard(), teamCard(), activityCard());
  }

  function passwordCard() {
    const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
    const nw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: '12', required: true });
    const nw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Change password');
    const form = h('form', { class: 'form-grid' },
      h('label', { class: 'field full' }, h('span', {}, 'Current password'), cur),
      h('label', { class: 'field' }, h('span', {}, 'New password'), nw, h('div', { class: 'field-hint' }, 'At least 12 characters. A passphrase works well.')),
      h('label', { class: 'field' }, h('span', {}, 'Repeat new password'), nw2),
      h('div', { class: 'full' }, btn));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (nw.value !== nw2.value) { toast('The new passwords don\'t match.', 'error'); return; }
      busy(btn, async () => {
        try {
          await api('/account/password', { method: 'POST', body: { currentPassword: cur.value, newPassword: nw.value } });
          form.reset();
          toast('Password changed. Other sessions were signed out.');
        } catch (err) { toast(err.message, 'error'); }
      });
    });
    return h('section', { class: 'card card-pad' }, h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Password'))), form);
  }

  function twoFactorCard() {
    const card = h('section', { class: 'card card-pad' });
    const draw = () => {
      const on = state.me.totpEnabled;
      card.replaceChildren(
        h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Two-factor authentication'), h('p', {}, 'Ask for a code from an authenticator app (Google Authenticator, 1Password, Authy…) when signing in.'))),
        h('div', { class: 'status-line' }, h('span', { class: `dot ${on ? 'on' : 'off'}` }), on ? 'On' : 'Off'),
      );
      const area = h('div', {});
      area.style.marginTop = '12px';
      card.append(area);
      if (on) {
        const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Your password', 'aria-label': 'Your password' });
        const off = h('button', { class: 'btn danger', type: 'button' }, 'Turn off');
        off.addEventListener('click', () => busy(off, async () => {
          try {
            await api('/account/2fa/disable', { method: 'POST', body: { password: pw.value } });
            state.me.totpEnabled = false; draw(); reloadTeam(); toast('Two-factor authentication turned off.');
          } catch (err) { toast(err.message, 'error'); }
        }));
        area.append(h('div', { class: 'row' }, pw, off));
        pw.style.maxWidth = '260px';
        return;
      }
      const start = h('button', { class: 'btn primary', type: 'button' }, 'Set up two-factor');
      start.addEventListener('click', () => busy(start, async () => {
        try {
          const { qr, secret } = await api('/account/2fa/setup', { method: 'POST' });
          const code = h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '7', placeholder: '123 456', 'aria-label': '6-digit code' });
          const confirmBtn = h('button', { class: 'btn primary', type: 'button' }, 'Turn on');
          confirmBtn.addEventListener('click', () => busy(confirmBtn, async () => {
            try {
              await api('/account/2fa/enable', { method: 'POST', body: { code: code.value } });
              state.me.totpEnabled = true; draw(); reloadTeam(); toast('Two-factor authentication is on.');
            } catch (err) { toast(err.message, 'error'); }
          }));
          code.style.maxWidth = '140px';
          area.replaceChildren(h('div', { class: 'twofa-setup' },
            h('img', { class: 'qr', src: qr, alt: 'QR code for your authenticator app' }),
            h('div', { class: 'stack' },
              h('p', {}, '1. Scan this QR code with your authenticator app.'),
              h('p', { class: 'small secondary' }, 'Can\'t scan? Enter this key manually: ', h('code', {}, secret.replace(/(.{4})/g, '$1 ').trim())),
              h('p', {}, '2. Enter the 6-digit code it shows.'),
              h('div', { class: 'row' }, code, confirmBtn))));
          code.focus();
        } catch (err) { toast(err.message, 'error'); }
      }));
      area.append(start);
    };
    draw();
    return card;
  }

  let reloadTeam = () => {};

  function teamCard() {
    const card = h('section', { class: 'card card-pad' });
    const list = h('div', { class: 'table-wrap' });
    const email = h('input', { class: 'input', type: 'email', autocomplete: 'off', required: true });
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: '12', required: true });
    const add = h('button', { class: 'btn primary', type: 'submit' }, 'Add user');
    const form = h('form', { class: 'form-grid' },
      h('label', { class: 'field' }, h('span', {}, 'Email'), email),
      h('label', { class: 'field' }, h('span', {}, 'Temporary password'), pw, h('div', { class: 'field-hint' }, 'Share it privately. They can change it after signing in.')),
      h('div', { class: 'full' }, add));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(add, async () => {
        try {
          await api('/users', { method: 'POST', body: { email: email.value, password: pw.value } });
          form.reset();
          toast('User added.');
          load();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
    async function load() {
      try {
        const { users } = await api('/users');
        list.replaceChildren(h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Email'), h('th', {}, '2FA'), h('th', {}, 'Last sign-in'), h('th', {}, ''))),
          h('tbody', {}, users.map((u) => {
            let action = h('span', { class: 'muted small' }, 'You');
            if (!u.isYou) {
              action = h('button', { class: 'btn ghost sm danger', type: 'button' }, 'Remove');
              action.addEventListener('click', () => busy(action, async () => {
                if (!confirm(`Remove ${u.email}? They will be signed out immediately.`)) return;
                try { await api(`/users/${u.id}`, { method: 'DELETE' }); toast('User removed.'); load(); } catch (err) { toast(err.message, 'error'); }
              }));
            }
            return h('tr', {},
              h('td', {}, u.email),
              h('td', {}, u.totpEnabled ? 'On' : h('span', { class: 'muted' }, 'Off')),
              h('td', { title: fullDate(u.lastLoginAt) }, u.lastLoginAt ? ago(u.lastLoginAt) : h('span', { class: 'muted' }, 'Never')),
              h('td', { class: 'num' }, action));
          }))));
      } catch (err) { toast(err.message, 'error'); }
    }
    card.append(
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Team'), h('p', {}, 'Everyone listed here has full admin access.'))),
      list, h('h3', { class: 'section-sub' }, 'Add someone'), form);
    card.querySelector('.section-sub').style.margin = '18px 0 10px';
    reloadTeam = load;
    load();
    return card;
  }

  function activityCard() {
    const card = h('section', { class: 'card card-pad' });
    const body = h('div', { class: 'table-wrap' }, h('p', { class: 'muted' }, 'Loading…'));
    card.append(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Recent activity'), h('p', {}, 'Sign-ins, replies and settings changes (last 100).'))), body);
    api('/activity').then(({ activity }) => {
      body.replaceChildren(h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'What'), h('th', {}, 'Details'), h('th', {}, 'IP'))),
        h('tbody', {}, activity.map((a) => h('tr', {},
          h('td', { title: fullDate(a.at) }, ago(a.at)),
          h('td', {}, a.user || h('span', { class: 'muted' }, a.action.startsWith('reply_auto') ? 'Auto-approve' : 'System')),
          h('td', {}, ACTIONS[a.action] || a.action),
          h('td', { class: 'secondary' }, a.detail || ''),
          h('td', { class: 'muted small' }, a.ip || ''))))));
    }).catch((err) => toast(err.message, 'error'));
    return card;
  }

  boot();
})();
