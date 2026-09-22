import { WsbProvider } from './wsb-provider.mjs';

const clean = value => String(value ?? '').trim();
const threadName = value => {
  const raw = clean(value);
  if (!raw) throw new Error('wsb_lifecycle_thread_missing');
  return raw.startsWith('t3_') ? raw : `t3_${raw}`;
};
const noopAsync = async () => ({ ok: true });

export const WSB_STAGE09_LIMITS = Object.freeze({
  retainedPostsPerPane: 2_000,
  hiddenPauseMs: 30_000,
  helperStopDelayMs: 5_000,
  helperStopMaxMs: 30_000
});

export class WsbPaneLifecycle {
  constructor({
    provider = new WsbProvider(),
    bridge = {},
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = id => clearTimeout(id),
    hiddenPauseMs = WSB_STAGE09_LIMITS.hiddenPauseMs,
    helperStopDelayMs = WSB_STAGE09_LIMITS.helperStopDelayMs
  } = {}) {
    if (helperStopDelayMs > WSB_STAGE09_LIMITS.helperStopMaxMs) throw new Error('wsb_helper_stop_delay_exceeds_limit');
    this.provider = provider;
    this.bridge = {
      startThread: typeof bridge.startThread === 'function' ? bridge.startThread : noopAsync,
      stopThread: typeof bridge.stopThread === 'function' ? bridge.stopThread : noopAsync,
      pauseAll: typeof bridge.pauseAll === 'function' ? bridge.pauseAll : noopAsync,
      resumeAll: typeof bridge.resumeAll === 'function' ? bridge.resumeAll : noopAsync,
      stopHelper: typeof bridge.stopHelper === 'function' ? bridge.stopHelper : noopAsync,
      setRetention: typeof bridge.setRetention === 'function' ? bridge.setRetention : noopAsync
    };
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.hiddenPauseMs = hiddenPauseMs;
    this.helperStopDelayMs = helperStopDelayMs;
    this.panes = new Map();
    this.threadRefs = new Map();
    this.threadGenerations = new Map();
    this.retentionBlocks = new Map();
    this.generationSerial = 0;
    this.hidden = false;
    this.hiddenPaused = false;
    this.hiddenTimer = 0;
    this.helperStopTimer = 0;
  }

  async openPane({ paneId, threadFullname, url = '', title = '' } = {}) {
    const pane = clean(paneId);
    if (!pane) throw new Error('wsb_lifecycle_pane_missing');
    const thread = threadName(threadFullname);
    const prior = this.panes.get(pane);
    if (prior?.thread === thread) return this.snapshotPane(pane);
    if (prior) await this.switchPane({ paneId: pane, threadFullname: thread, url, title });
    else {
      this.#cancelHelperStop();
      this.provider.subscribe(pane, thread);
      const refs = (this.threadRefs.get(thread) || 0) + 1;
      const generation = refs === 1 ? ++this.generationSerial : this.threadGenerations.get(thread);
      this.threadRefs.set(thread, refs);this.threadGenerations.set(thread,generation);
      this.panes.set(pane, { paneId: pane, thread, generation, url: clean(url), title: clean(title) });
      if (refs === 1) {
        const started = await this.bridge.startThread({ threadFullname: thread, url: clean(url), title: clean(title), generation });
        if (started?.ok === false) {
          this.provider.unsubscribe(pane);this.panes.delete(pane);this.threadRefs.delete(thread);this.threadGenerations.delete(thread);
          throw new Error(clean(started.reason) || 'wsb_thread_start_rejected');
        }
      }
    }
    return this.snapshotPane(pane);
  }

  async switchPane({ paneId, threadFullname, url = '', title = '' } = {}) {
    const pane = clean(paneId), next = threadName(threadFullname);
    const prior = this.panes.get(pane);
    if (!prior) return this.openPane({ paneId: pane, threadFullname: next, url, title });
    if (prior.thread === next) return this.snapshotPane(pane);

    // Start a brand-new target before detaching the current subscription. A rejected
    // target must leave the visible/history owner on the old thread.
    const existingNextRefs = this.threadRefs.get(next) || 0;
    const generation = existingNextRefs > 0 ? this.threadGenerations.get(next) : this.generationSerial + 1;
    if (existingNextRefs === 0) {
      const started = await this.bridge.startThread({ threadFullname: next, url: clean(url), title: clean(title), generation });
      if (started?.ok === false) throw new Error(clean(started.reason) || 'wsb_thread_start_rejected');
    }

    await this.#detachPane(pane, { stopHelperIfEmpty: false });
    this.#cancelHelperStop();
    this.provider.subscribe(pane, next);
    const refs = (this.threadRefs.get(next) || 0) + 1;
    if (existingNextRefs === 0) this.generationSerial = generation;
    this.threadRefs.set(next, refs);this.threadGenerations.set(next,generation);
    this.panes.set(pane, { paneId: pane, thread: next, generation, url: clean(url), title: clean(title) });
    return this.snapshotPane(pane);
  }

  async closePane(paneId) {
    const pane = clean(paneId);
    if (!pane || !this.panes.has(pane)) return null;
    const result = await this.#detachPane(pane, { stopHelperIfEmpty: true });
    return result;
  }

  async #detachPane(pane, { stopHelperIfEmpty } = {}) {
    const prior = this.panes.get(pane);
    if (!prior) return null;
    this.panes.delete(pane);
    const blocks = this.retentionBlocks.get(prior.thread);const wasBlocked = !!blocks?.size;
    blocks?.delete(pane);if (blocks && !blocks.size) this.retentionBlocks.delete(prior.thread);
    const detached = this.provider.unsubscribe(pane);
    const refs = Math.max(0, (this.threadRefs.get(prior.thread) || 1) - 1);
    if (refs > 0 && wasBlocked && !this.retentionBlocks.get(prior.thread)?.size) await this.bridge.setRetention({ threadFullname: prior.thread, generation: prior.generation, paused: false, blockedPanes: 0 });
    if (refs > 0) this.threadRefs.set(prior.thread, refs);
    else {
      this.threadRefs.delete(prior.thread);this.threadGenerations.delete(prior.thread);this.retentionBlocks.delete(prior.thread);
      try { await this.bridge.stopThread({ threadFullname: prior.thread, generation: prior.generation, reason: 'last-pane-closed' }); } catch { /* lifecycle state is already detached; cleanup remains best-effort */ }
    }
    if (stopHelperIfEmpty && this.panes.size === 0) this.#scheduleHelperStop();
    return Object.freeze({ paneId: pane, threadFullname: prior.thread, refCount: refs, detached });
  }

  async updateRetention(paneId, paused) {
    const pane = this.panes.get(clean(paneId));
    if (!pane) return false;
    let blocked = this.retentionBlocks.get(pane.thread);
    if (!blocked) { blocked = new Set(); this.retentionBlocks.set(pane.thread, blocked); }
    const before = blocked.size;
    if (paused) blocked.add(pane.paneId); else blocked.delete(pane.paneId);
    if (!blocked.size) this.retentionBlocks.delete(pane.thread);
    if ((before === 0 && blocked.size > 0) || (before > 0 && blocked.size === 0)) {
      await this.bridge.setRetention({ threadFullname: pane.thread, generation: pane.generation, paused: blocked.size > 0, blockedPanes: blocked.size });
    }
    return true;
  }

  setPaneGeneration(paneId, generation) {
    const pane = this.panes.get(clean(paneId));
    if (!pane) return false;
    const next = Number(generation);
    if (!Number.isInteger(next) || next < pane.generation) return false;
    pane.generation = next;
    return true;
  }

  async setHidden(hidden) {
    const next = Boolean(hidden);
    if (next === this.hidden) return this.snapshot();
    this.hidden = next;
    if (next) {
      this.#cancelHiddenTimer();
      this.hiddenTimer = this.setTimer(async () => {
        this.hiddenTimer = 0;
        if (!this.hidden || this.panes.size === 0) return;
        this.hiddenPaused = true;
        await this.bridge.pauseAll({ reason: 'app-hidden', paneCount: this.panes.size });
      }, this.hiddenPauseMs);
    } else {
      this.#cancelHiddenTimer();
      if (this.hiddenPaused) {
        this.hiddenPaused = false;
        await this.bridge.resumeAll({ reason: 'app-visible', markGap: true, paneCount: this.panes.size });
      }
    }
    return this.snapshot();
  }

  async shutdown() {
    this.#cancelHiddenTimer();
    this.#cancelHelperStop();
    for (const paneId of [...this.panes.keys()]) await this.#detachPane(paneId, { stopHelperIfEmpty: false });
    await this.bridge.stopHelper({ reason: 'shutdown' });
    this.hiddenPaused = false;
    return this.snapshot();
  }

  snapshotPane(paneId) {
    const pane = this.panes.get(clean(paneId));
    if (!pane) return null;
    return Object.freeze({ paneId: pane.paneId, threadFullname: pane.thread, generation: pane.generation, refCount: this.threadRefs.get(pane.thread) || 0, hiddenPaused: this.hiddenPaused });
  }

  snapshot() {
    return Object.freeze({
      paneCount: this.panes.size,
      threadCount: this.threadRefs.size,
      hidden: this.hidden,
      hiddenPaused: this.hiddenPaused,
      panes: Object.freeze([...this.panes.values()].map(p => Object.freeze({ paneId: p.paneId, threadFullname: p.thread, generation: p.generation, refCount: this.threadRefs.get(p.thread) || 0 })))
    });
  }

  #cancelHiddenTimer() { if (this.hiddenTimer) { this.clearTimer(this.hiddenTimer); this.hiddenTimer = 0; } }
  #cancelHelperStop() { if (this.helperStopTimer) { this.clearTimer(this.helperStopTimer); this.helperStopTimer = 0; } }
  #scheduleHelperStop() {
    this.#cancelHelperStop();
    this.helperStopTimer = this.setTimer(async () => {
      this.helperStopTimer = 0;
      if (this.panes.size === 0) await this.bridge.stopHelper({ reason: 'no-wsb-panes' });
    }, this.helperStopDelayMs);
  }
}

export function wsbPostKey(commentFullname) {
  const id = clean(commentFullname);
  if (!/^t1_[a-z0-9]+$/i.test(id)) throw new Error('wsb_post_fullname_invalid');
  return `reddit:${id}`;
}

export function mapTranslatedWsbRow(row = {}, ordinal = 1) {
  const fullname = clean(row.commentId || row.fullname || row.id);
  const key = wsbPostKey(fullname);
  const createdUtc = Number(row.createdUtc ?? row.created_utc ?? 0) || 0;
  const translated = row.status === 'failed' ? '翻訳できませんでした' : String(row.text ?? row.translatedText ?? '');
  if (!translated) throw new Error('wsb_translated_text_missing');
  const date = createdUtc > 0 ? new Date(createdUtc * 1000) : new Date(0);
  const stamp = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  return {
    key,
    n: String(Math.max(1, Number(ordinal) || 1)),
    name: clean(row.author),
    id: '',
    date: stamp,
    body: translated,
    attachments: [],
    links: [],
    redditFullname: fullname,
    redditCreatedUtc: createdUtc,
    redditOriginal: String(row.original ?? row.sourceText ?? row.body ?? ''),
    redditTranslationStatus: row.status === 'failed' ? 'failed' : 'translated',
    redditTranslationError: clean(row.error),
    redditMachineTranslated: true
  };
}

export function trimWsbPosts(posts = [], { limit = WSB_STAGE09_LIMITS.retainedPostsPerPane, protectedKeys = [] } = {}) {
  const source = Array.isArray(posts) ? posts : [];
  if (source.length <= limit) return Object.freeze({ posts: source.slice(), removed: Object.freeze([]), paused: false });
  const protectedSet = new Set((protectedKeys || []).map(clean).filter(Boolean));
  let removeCount = source.length - limit;
  const removed = [], kept = [];
  for (const post of source) {
    const key = clean(post?.key);
    if (removeCount > 0 && !protectedSet.has(key)) { removed.push(key); removeCount -= 1; }
    else kept.push(post);
  }
  return Object.freeze({ posts: kept, removed: Object.freeze(removed), paused: removeCount > 0 });
}
