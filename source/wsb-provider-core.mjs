import { assertApprovedRedditConfig, buildReadRequest } from './wsb-reddit-contract.mjs';

export const WSB_STAGE08_LIMITS = Object.freeze({
  subreddit: 'wallstreetbets',
  candidateRefreshMs: 60_000,
  latestPollMs: 5_000,
  initialThreadComments: 100,
  latestCommentListing: 100,
  maxBackfillPages: 3,
  initialRequestBudgetPerMinute: 60,
  maxRetainedPerPane: 2_000,
  translationQueueMax: 200,
  translationHighWaterMs: 120_000,
  translationTimeoutMs: 15_000,
  translationRetries: 1,
  translationBatchItems: 8,
  translationBatchChars: 4_000,
  rendererCommitMinIntervalMs: 250,
  rendererCommitMaxItems: 20
});

const TITLE_FAMILIES = Object.freeze([
  Object.freeze({ id: 'daily', re: /\bdaily discussion thread\b/i, base: 42 }),
  Object.freeze({ id: 'moves', re: /\bwhat are your moves tomorrow\b/i, base: 38 }),
  Object.freeze({ id: 'weekend', re: /\bweekend discussion(?: thread)?\b/i, base: 40 })
]);

const clean = value => String(value ?? '').trim();
const asFinite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const fullname = (kind, id) => {
  const raw = clean(id);
  if (!raw) return '';
  return raw.startsWith(`${kind}_`) ? raw : `${kind}_${raw}`;
};

export function classifyWsbTitle(title) {
  const text = clean(title);
  const hit = TITLE_FAMILIES.find(item => item.re.test(text));
  return hit ? Object.freeze({ family: hit.id, familyScore: hit.base }) : Object.freeze({ family: 'other', familyScore: 0 });
}

export function newYorkParts(epochSeconds) {
  const d = new Date(asFinite(epochSeconds) * 1000);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short'
  });
  const parts = Object.fromEntries(formatter.formatToParts(d).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return Object.freeze(parts);
}

export function normalizeSubmission(raw = {}, sources = []) {
  const data = raw?.data ?? raw;
  const id = clean(data.id).replace(/^t3_/, '');
  if (!id) throw new Error('wsb_submission_id_missing');
  const subreddit = clean(data.subreddit).toLowerCase();
  const createdUtc = asFinite(data.created_utc, 0);
  const numComments = Math.max(0, asFinite(data.num_comments, 0));
  const title = clean(data.title);
  const family = classifyWsbTitle(title);
  return Object.freeze({
    id,
    fullname: fullname('t3', data.name || id),
    title,
    family: family.family,
    familyScore: family.familyScore,
    createdUtc,
    stickied: Boolean(data.stickied || data.pinned),
    numComments,
    permalink: clean(data.permalink),
    url: clean(data.url),
    subreddit,
    sources: Object.freeze([...new Set(sources.map(clean).filter(Boolean))])
  });
}

const listingRows = value => Array.isArray(value) ? value : (value?.data?.children ?? value?.children ?? []);

export function mergeCandidateListings({ hot = [], newest = [] } = {}) {
  const byId = new Map();
  const add = (row, source) => {
    const item = normalizeSubmission(row, [source]);
    const prior = byId.get(item.id);
    if (!prior) {
      byId.set(item.id, item);
      return;
    }
    const rawData = row?.data ?? row;
    byId.set(item.id, normalizeSubmission({
      ...rawData,
      id: item.id,
      name: item.fullname,
      title: item.title || prior.title,
      created_utc: item.createdUtc || prior.createdUtc,
      num_comments: Math.max(item.numComments, prior.numComments),
      stickied: item.stickied || prior.stickied,
      subreddit: item.subreddit || prior.subreddit,
      permalink: item.permalink || prior.permalink,
      url: item.url || prior.url
    }, [...prior.sources, source]));
  };
  listingRows(hot).forEach(row => add(row, 'hot'));
  listingRows(newest).forEach(row => add(row, 'new'));
  return [...byId.values()];
}

export function scoreWsbCandidate(candidate, { nowUtc, previousSample = null } = {}) {
  const now = asFinite(nowUtc, Date.now() / 1000);
  const ageHours = Math.max(0, (now - candidate.createdUtc) / 3600);
  const recency = Math.max(-25, 32 - Math.min(ageHours, 114) * 0.5);
  const sticky = candidate.stickied ? 14 : 0;
  const sourceScore = (candidate.sources.includes('hot') ? 3 : 0) + (candidate.sources.includes('new') ? 3 : 0);
  let growthPerMinute = 0;
  if (previousSample && previousSample.id === candidate.id) {
    const elapsedMinutes = Math.max(1 / 60, (now - asFinite(previousSample.sampledAtUtc, now)) / 60);
    growthPerMinute = Math.max(0, candidate.numComments - asFinite(previousSample.numComments, candidate.numComments)) / elapsedMinutes;
  }
  const growth = Math.min(30, growthPerMinute * 2);
  // Raw lifetime comment count is deliberately weak: old huge threads must not win merely because they are huge.
  const lifetime = Math.min(5, Math.log10(candidate.numComments + 1));
  const score = candidate.familyScore + recency + sticky + sourceScore + growth + lifetime;
  return Object.freeze({ candidate, score, ageHours, growthPerMinute, partsNY: newYorkParts(candidate.createdUtc) });
}

export function rankWsbCandidates({ hot = [], newest = [], nowUtc, previousSamples = new Map(), maxMenu = 3 } = {}) {
  const merged = mergeCandidateListings({ hot, newest })
    .filter(item => item.subreddit === WSB_STAGE08_LIMITS.subreddit)
    .filter(item => item.family !== 'other');
  const ranked = merged
    .map(item => scoreWsbCandidate(item, { nowUtc, previousSample: previousSamples.get(item.id) ?? null }))
    .sort((a, b) => b.score - a.score || b.candidate.createdUtc - a.candidate.createdUtc || a.candidate.fullname.localeCompare(b.candidate.fullname));
  const top = ranked[0] ?? null;
  const second = ranked[1] ?? null;
  const ambiguous = Boolean(top && second && Math.abs(top.score - second.score) <= 8);
  return Object.freeze({
    ranked: Object.freeze(ranked),
    automatic: ambiguous ? null : top?.candidate ?? null,
    menu: Object.freeze((ambiguous ? ranked.slice(0, Math.max(2, Math.min(maxMenu, 3))) : top ? [top] : []).map(x => x.candidate)),
    ambiguous
  });
}

export class WsbThreadSwitchAdvisor {
  constructor({ superiorityMargin = 8, consecutiveWins = 2 } = {}) {
    this.superiorityMargin = superiorityMargin;
    this.consecutiveWins = consecutiveWins;
    this.pending = null;
  }

  observe({ currentId, ranked, mode = 'live' } = {}) {
    const current = ranked.find(x => x.candidate.id === currentId) ?? null;
    const challenger = ranked.find(x => x.candidate.id !== currentId) ?? null;
    if (!challenger || !current || challenger.score - current.score < this.superiorityMargin) {
      this.pending = null;
      return Object.freeze({ action: 'stay', challenger: null, wins: 0 });
    }
    if (!this.pending || this.pending.id !== challenger.candidate.id) this.pending = { id: challenger.candidate.id, wins: 0 };
    this.pending.wins += 1;
    if (this.pending.wins < this.consecutiveWins) return Object.freeze({ action: 'observe', challenger: challenger.candidate, wins: this.pending.wins });
    if (mode === 'live' || mode === 'following') return Object.freeze({ action: 'switch', challenger: challenger.candidate, wins: this.pending.wins });
    return Object.freeze({ action: 'notify', challenger: challenger.candidate, wins: this.pending.wins });
  }
}

export function parseManualWsbUrl(rawUrl) {
  const u = new URL(clean(rawUrl));
  if (!['https:', 'http:'].includes(u.protocol)) throw new Error('wsb_manual_url_protocol');
  if (!/(^|\.)reddit\.com$/i.test(u.hostname)) throw new Error('wsb_manual_url_host');
  const match = u.pathname.match(/^\/r\/wallstreetbets\/comments\/([a-z0-9]+)(?:\/|$)/i);
  if (!match) throw new Error('wsb_manual_url_path');
  return Object.freeze({ submissionId: match[1].toLowerCase(), url: u.toString() });
}

export function verifyManualWsbSubmission(rawUrl, submission) {
  const parsed = parseManualWsbUrl(rawUrl);
  const normalized = normalizeSubmission(submission, ['manual']);
  if (normalized.id !== parsed.submissionId) throw new Error('wsb_manual_submission_id_mismatch');
  if (normalized.subreddit !== WSB_STAGE08_LIMITS.subreddit) throw new Error('wsb_manual_subreddit_mismatch');
  return normalized;
}

export function buildWsbReadRequest(config, { accessToken, kind, threadId = '', after = '', ids = [] } = {}) {
  assertApprovedRedditConfig(config);
  const limit = WSB_STAGE08_LIMITS.latestCommentListing;
  if (kind === 'hot' || kind === 'new') return buildReadRequest(config, { accessToken, path: `/r/wallstreetbets/${kind}`, query: { limit: 25, raw_json: 1 } });
  if (kind === 'latestComments') return buildReadRequest(config, { accessToken, path: '/r/wallstreetbets/comments', query: { limit, after: after || undefined, raw_json: 1 } });
  if (kind === 'threadComments') {
    const id = clean(threadId).replace(/^t3_/, '');
    if (!/^[a-z0-9]+$/i.test(id)) throw new Error('wsb_thread_id_invalid');
    return buildReadRequest(config, { accessToken, path: `/comments/${id}`, query: { limit: WSB_STAGE08_LIMITS.initialThreadComments, sort: 'new', raw_json: 1 } });
  }
  if (kind === 'info') {
    const infoIds = [...new Set((Array.isArray(ids) ? ids : []).map(clean).filter(x => /^t1_[a-z0-9]+$/i.test(x)))].slice(0, 100);
    if (!infoIds.length) throw new Error('wsb_info_ids_invalid');
    return buildReadRequest(config, { accessToken, path: '/api/info', query: { id: infoIds.join(','), raw_json: 1 } });
  }
  throw new Error('wsb_request_kind_invalid');
}

export class WsbAuthState {
  constructor() { this.state = 'signed-out'; this.expiresAt = 0; this.reason = ''; }
  authenticated({ expiresAt }) { this.state = 'authenticated'; this.expiresAt = asFinite(expiresAt, 0); this.reason = ''; }
  validate(nowMs = Date.now()) {
    if (this.state === 'authenticated' && this.expiresAt > 0 && nowMs >= this.expiresAt) {
      this.state = 'expired'; this.reason = 'token-expired';
    }
    return this.snapshot();
  }
  onHttpStatus(status) {
    if (status === 401) { this.state = 'expired'; this.reason = 'oauth-unauthorized'; }
    if (status === 403) { this.state = 'error'; this.reason = 'oauth-forbidden'; }
    return this.snapshot();
  }
  revoke() { this.state = 'signed-out'; this.expiresAt = 0; this.reason = 'revoked'; return this.snapshot(); }
  snapshot() { return Object.freeze({ state: this.state, expiresAt: this.expiresAt, reason: this.reason }); }
}
