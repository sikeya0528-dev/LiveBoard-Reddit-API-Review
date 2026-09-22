const clean = value => String(value ?? '').trim();
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const fullname = (kind, value) => {
  const raw = clean(value);
  if (!raw) return '';
  return raw.startsWith(`${kind}_`) ? raw : `${kind}_${raw}`;
};

export function normalizeWsbComment(raw = {}) {
  const data = raw?.data ?? raw;
  const id = clean(data.id).replace(/^t1_/, '');
  if (!id) throw new Error('wsb_comment_id_missing');
  const name = fullname('t1', data.name || id);
  const linkId = fullname('t3', data.link_id || data.linkId || '');
  if (!linkId) throw new Error('wsb_comment_link_id_missing');
  return Object.freeze({
    id,
    fullname: name,
    linkId,
    parentId: clean(data.parent_id || data.parentId),
    createdUtc: num(data.created_utc ?? data.createdUtc, 0),
    body: String(data.body ?? ''),
    author: clean(typeof data.author === 'string' ? data.author : data.author?.name),
    edited: data.edited === false ? false : data.edited || false,
    subreddit: clean(data.subreddit).toLowerCase(),
    score: num(data.score, 0),
    deleted: Boolean(data.deleted || data.removed || data.body === '[deleted]' || data.body === '[removed]')
  });
}

export function flattenThreadCommentTree(input) {
  const out = [];
  const visit = node => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const kind = node.kind ?? node?.data?.kind;
    const data = node.data ?? node;
    if (kind === 'more' || data?.count && !data?.body) return;
    if (data?.body !== undefined && (data?.id || data?.name)) {
      try { out.push(normalizeWsbComment(data)); } catch { /* non-comment child */ }
    }
    const replies = data?.replies;
    if (replies && typeof replies === 'object') {
      const children = replies?.data?.children ?? replies?.children ?? [];
      visit(children);
    }
    if (Array.isArray(data?.children)) visit(data.children);
  };
  const roots = input?.data?.children ?? input?.children ?? input;
  visit(roots);
  return out;
}

export function stableCommentSort(items) {
  return [...items].sort((a, b) => a.createdUtc - b.createdUtc || a.fullname.localeCompare(b.fullname));
}

export class WsbFlatStream {
  constructor({ threadFullname, generation = 1, maxRetained = 2000 } = {}) {
    this.threadFullname = fullname('t3', threadFullname);
    if (!this.threadFullname) throw new Error('wsb_stream_thread_missing');
    this.generation = generation;
    this.maxRetained = maxRetained;
    this.byId = new Map();
    this.latestCursor = null;
    this.translatedCursor = null;
    this.gaps = [];
    this.pausedForRetention = false;
  }

  switchThread(threadFullname) {
    this.threadFullname = fullname('t3', threadFullname);
    this.generation += 1;
    this.byId.clear();
    this.latestCursor = null;
    this.translatedCursor = null;
    this.gaps = [];
    this.pausedForRetention = false;
    return this.generation;
  }

  seedInitial(input, { generation = this.generation, limit = 100 } = {}) {
    if (generation !== this.generation) return Object.freeze({ ignored: true, reason: 'stale-generation' });
    const comments = stableCommentSort(flattenThreadCommentTree(input).filter(c => c.linkId === this.threadFullname && !c.deleted));
    const selected = comments.slice(-Math.max(1, limit));
    for (const comment of selected) this.byId.set(comment.fullname, comment);
    if (selected.length) this.latestCursor = selected[selected.length - 1].fullname;
    this.#enforceRetention(new Set());
    return Object.freeze({ ignored: false, added: Object.freeze(selected), total: this.byId.size });
  }

  ingestLatestPages(pages, { generation = this.generation, polledAt = Date.now(), protectedIds = [] } = {}) {
    if (generation !== this.generation) return Object.freeze({ ignored: true, reason: 'stale-generation', added: Object.freeze([]) });
    const knownBefore = new Set(this.byId.keys());
    const matching = [];
    let overlap = false;
    let pagesExamined = 0;
    let nextAfter = '';
    for (const page of (pages ?? []).slice(0, 3)) {
      pagesExamined += 1;
      const children = page?.data?.children ?? page?.children ?? [];
      for (const child of children) {
        let comment;
        try { comment = normalizeWsbComment(child); } catch { continue; }
        if (comment.linkId !== this.threadFullname || comment.deleted) continue;
        if (knownBefore.has(comment.fullname)) overlap = true;
        matching.push(comment);
      }
      nextAfter = clean(page?.data?.after ?? page?.after);
      if (overlap) break;
    }

    const deduped = new Map();
    for (const comment of matching) deduped.set(comment.fullname, comment);
    const ordered = stableCommentSort([...deduped.values()]);
    const added = [];
    for (const comment of ordered) {
      const prior = this.byId.get(comment.fullname);
      if (!prior) added.push(comment);
      this.byId.set(comment.fullname, comment);
    }
    if (ordered.length) this.latestCursor = ordered[ordered.length - 1].fullname;

    let gap = null;
    const hadKnown = knownBefore.size > 0;
    const exhaustedBudget = pagesExamined >= 3 || !nextAfter;
    if (hadKnown && ordered.length > 0 && !overlap && exhaustedBudget) {
      const sortedKnown = stableCommentSort([...this.byId.values()]);
      const oldestNew = ordered[0];
      const previous = [...sortedKnown].filter(x => knownBefore.has(x.fullname) && x.createdUtc <= oldestNew.createdUtc).at(-1) ?? null;
      gap = Object.freeze({
        type: 'missing-interval',
        detectedAt: polledAt,
        afterId: previous?.fullname ?? null,
        beforeId: oldestNew.fullname,
        reason: 'no-overlap-within-3-pages'
      });
      this.gaps.push(gap);
    }

    this.#enforceRetention(new Set(protectedIds));
    return Object.freeze({
      ignored: false,
      added: Object.freeze(added),
      overlap,
      gap,
      pagesExamined,
      needsBackfill: Boolean(hadKnown && ordered.length > 0 && !overlap && !exhaustedBudget),
      nextAfter: hadKnown && ordered.length > 0 && !overlap && !exhaustedBudget ? nextAfter : null,
      total: this.byId.size,
      pausedForRetention: this.pausedForRetention
    });
  }

  applyContentChecks(records, { generation = this.generation } = {}) {
    if (generation !== this.generation) return Object.freeze({ ignored: true, reason: 'stale-generation' });
    const removed = [];
    const updated = [];
    for (const raw of records ?? []) {
      let comment;
      try { comment = normalizeWsbComment(raw); } catch { continue; }
      if (comment.linkId !== this.threadFullname || !this.byId.has(comment.fullname)) continue;
      if (comment.deleted) {
        this.byId.delete(comment.fullname);
        removed.push(comment.fullname);
        continue;
      }
      const prior = this.byId.get(comment.fullname);
      if (prior.body !== comment.body || prior.edited !== comment.edited || prior.author !== comment.author) {
        this.byId.set(comment.fullname, comment);
        updated.push(comment);
      }
    }
    if (this.translatedCursor && !this.byId.has(this.translatedCursor)) this.translatedCursor = null;
    return Object.freeze({ ignored: false, removed: Object.freeze(removed), updated: Object.freeze(updated) });
  }

  markTranslated(commentFullname, { generation = this.generation } = {}) {
    if (generation !== this.generation) return false;
    if (!this.byId.has(commentFullname)) return false;
    this.translatedCursor = commentFullname;
    return true;
  }

  #enforceRetention(protectedIds) {
    this.pausedForRetention = false;
    if (this.byId.size <= this.maxRetained) return;
    const ordered = stableCommentSort([...this.byId.values()]);
    let toRemove = this.byId.size - this.maxRetained;
    for (const comment of ordered) {
      if (toRemove <= 0) break;
      if (protectedIds.has(comment.fullname)) continue;
      this.byId.delete(comment.fullname);
      toRemove -= 1;
    }
    if (toRemove > 0) this.pausedForRetention = true;
  }

  snapshot() {
    return Object.freeze({
      generation: this.generation,
      threadFullname: this.threadFullname,
      comments: Object.freeze(stableCommentSort([...this.byId.values()])),
      latestCursor: this.latestCursor,
      translatedCursor: this.translatedCursor,
      gaps: Object.freeze([...this.gaps]),
      pausedForRetention: this.pausedForRetention
    });
  }
}
