const clean = value => String(value ?? '').trim();
const charLength = value => [...String(value ?? '')].length;

export class WsbTranslationQueue {
  constructor({
    generation = 1,
    maxItems = 200,
    highWaterMs = 120_000,
    timeoutMs = 15_000,
    retries = 1,
    batchMaxItems = 8,
    batchMaxChars = 4_000,
    commitMinIntervalMs = 250,
    commitMaxItems = 20
  } = {}) {
    this.generation = generation;
    this.maxItems = maxItems;
    this.highWaterMs = highWaterMs;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.batchMaxItems = batchMaxItems;
    this.batchMaxChars = batchMaxChars;
    this.commitMinIntervalMs = commitMinIntervalMs;
    this.commitMaxItems = commitMaxItems;
    this.entries = [];
    this.byId = new Map();
    this.activeBatch = null;
    this.batchSerial = 0;
    this.sequenceSerial = 0;
    this.nextCommitIndex = 0;
    this.lastCommitAt = -Infinity;
  }

  enqueue(items, { generation = this.generation, now = Date.now() } = {}) {
    if (generation !== this.generation) return Object.freeze({ accepted: false, reason: 'stale-generation', count: 0, ...this.status(now) });
    const normalized = [];
    for (const raw of items ?? []) {
      const id = clean(raw?.commentId || raw?.id || raw?.fullname);
      if (!id || this.byId.has(id)) continue;
      const text = String(raw?.text ?? raw?.body ?? '');
      if (!text) continue;
      normalized.push({ id, text, createdUtc: Number(raw?.createdUtc ?? 0) || 0 });
    }
    const liveCount = this.entries.slice(this.nextCommitIndex).filter(x => x.status !== 'removed').length;
    if (liveCount + normalized.length > this.maxItems) return Object.freeze({ accepted: false, reason: 'queue-capacity', count: 0, ...this.status(now) });
    for (const item of normalized) {
      const entry = {
        seq: ++this.sequenceSerial,
        id: item.id,
        text: item.text,
        createdUtc: item.createdUtc,
        generation: this.generation,
        enqueuedAt: now,
        status: 'waiting',
        attempts: 0,
        translatedText: '',
        error: ''
      };
      this.entries.push(entry);
      this.byId.set(entry.id, entry);
    }
    return Object.freeze({ accepted: true, reason: '', count: normalized.length, ...this.status(now) });
  }

  takeBatch({ generation = this.generation, now = Date.now() } = {}) {
    if (generation !== this.generation || this.activeBatch) return null;
    const selected = [];
    let chars = 0;
    for (let i = this.nextCommitIndex; i < this.entries.length; i += 1) {
      const entry = this.entries[i];
      if (entry.status !== 'waiting') continue;
      const n = charLength(entry.text);
      if (selected.length && (selected.length >= this.batchMaxItems || chars + n > this.batchMaxChars)) break;
      if (!selected.length && n > this.batchMaxChars) {
        entry.status = 'failed';
        entry.error = 'source-too-long';
        continue;
      }
      selected.push(entry);
      chars += n;
      if (selected.length >= this.batchMaxItems) break;
    }
    if (!selected.length) return null;
    const batchId = `g${this.generation}-b${++this.batchSerial}`;
    for (const entry of selected) {
      entry.status = 'inflight';
      entry.attempts += 1;
    }
    this.activeBatch = { batchId, generation: this.generation, startedAt: now, ids: selected.map(x => x.id) };
    return Object.freeze({
      batchId,
      generation: this.generation,
      items: Object.freeze(selected.map(entry => Object.freeze({ commentId: entry.id, text: entry.text }))),
      totalChars: chars
    });
  }

  acceptResults({ batchId, generation = this.generation, results = [], now = Date.now() } = {}) {
    const active = this.activeBatch;
    if (!active || active.batchId !== batchId || generation !== this.generation || active.generation !== this.generation) {
      return Object.freeze({ accepted: false, reason: 'stale-or-unknown-batch' });
    }
    const byResult = new Map((results ?? []).map(row => [clean(row.commentId || row.id), row]));
    for (const id of active.ids) {
      const entry = this.byId.get(id);
      if (!entry || entry.generation !== this.generation || entry.status === 'removed') continue;
      const result = byResult.get(id);
      if (result?.ok === true && typeof result.text === 'string') {
        entry.status = 'done';
        entry.translatedText = result.text;
        entry.error = '';
      } else if (entry.attempts <= this.retries) {
        entry.status = 'waiting';
        entry.error = clean(result?.error || 'translation-failed');
      } else {
        entry.status = 'failed';
        entry.error = clean(result?.error || 'translation-failed');
      }
    }
    this.activeBatch = null;
    return Object.freeze({ accepted: true, ...this.status(now) });
  }

  checkTimeout(now = Date.now()) {
    if (!this.activeBatch || now - this.activeBatch.startedAt < this.timeoutMs) return Object.freeze({ timedOut: false, ...this.status(now) });
    const ids = [...this.activeBatch.ids];
    for (const id of ids) {
      const entry = this.byId.get(id);
      if (!entry || entry.status === 'removed') continue;
      if (entry.attempts <= this.retries) {
        entry.status = 'waiting';
        entry.error = 'translation-timeout';
      } else {
        entry.status = 'failed';
        entry.error = 'translation-timeout';
      }
    }
    this.activeBatch = null;
    return Object.freeze({ timedOut: true, ids: Object.freeze(ids), ...this.status(now) });
  }

  helperCrashed({ now = Date.now() } = {}) {
    if (!this.activeBatch) return Object.freeze({ recovered: false, ...this.status(now) });
    const ids = [...this.activeBatch.ids];
    for (const id of ids) {
      const entry = this.byId.get(id);
      if (!entry || entry.status === 'removed') continue;
      if (entry.attempts <= this.retries) {
        entry.status = 'waiting';
        entry.error = 'helper-crash';
      } else {
        entry.status = 'failed';
        entry.error = 'helper-crash';
      }
    }
    this.activeBatch = null;
    return Object.freeze({ recovered: true, ids: Object.freeze(ids), ...this.status(now) });
  }

  removeComment(commentId) {
    const id = clean(commentId);
    const entry = this.byId.get(id);
    if (!entry) return false;
    entry.status = 'removed';
    entry.text = '';
    entry.translatedText = '';
    entry.error = 'deleted';
    this.byId.delete(id);
    if (this.activeBatch?.ids.includes(id)) {
      this.activeBatch.ids = this.activeBatch.ids.filter(x => x !== id);
      if (this.activeBatch.ids.length === 0) this.activeBatch = null;
    }
    return true;
  }

  commitReady(now = Date.now()) {
    if (now - this.lastCommitAt < this.commitMinIntervalMs) return Object.freeze({ committed: Object.freeze([]), blockedByInterval: true });
    const output = [];
    while (this.nextCommitIndex < this.entries.length && output.length < this.commitMaxItems) {
      const entry = this.entries[this.nextCommitIndex];
      if (entry.status === 'removed') {
        this.nextCommitIndex += 1;
        continue;
      }
      if (entry.status !== 'done' && entry.status !== 'failed') break;
      output.push(Object.freeze({
        commentId: entry.id,
        status: entry.status === 'done' ? 'translated' : 'failed',
        text: entry.status === 'done' ? entry.translatedText : '翻訳できませんでした',
        canViewOriginal: entry.status === 'failed',
        error: entry.status === 'failed' ? entry.error : ''
      }));
      this.byId.delete(entry.id);
      this.nextCommitIndex += 1;
    }
    if (output.length) this.lastCommitAt = now;
    if (this.nextCommitIndex > 512 && this.nextCommitIndex > this.entries.length / 2) {
      this.entries = this.entries.slice(this.nextCommitIndex);
      this.nextCommitIndex = 0;
    }
    return Object.freeze({ committed: Object.freeze(output), blockedByInterval: false });
  }

  setGeneration(nextGeneration) {
    const next = Number(nextGeneration);
    if (!Number.isInteger(next) || next <= this.generation) throw new Error('translation_generation_must_increase');
    this.generation = next;
    this.entries = [];
    this.byId.clear();
    this.activeBatch = null;
    this.nextCommitIndex = 0;
    this.sequenceSerial = 0;
    this.batchSerial = 0;
    this.lastCommitAt = -Infinity;
    return this.generation;
  }

  status(now = Date.now()) {
    const pending = this.entries.slice(this.nextCommitIndex).filter(x => !['removed'].includes(x.status));
    const waiting = pending.filter(x => ['waiting', 'inflight'].includes(x.status));
    const oldest = waiting.length ? Math.min(...waiting.map(x => x.enqueuedAt)) : now;
    const oldestWaitMs = waiting.length ? Math.max(0, now - oldest) : 0;
    const highWater = pending.length >= this.maxItems || oldestWaitMs >= this.highWaterMs;
    return {
      generation: this.generation,
      backlog: pending.length,
      waiting: waiting.length,
      oldestWaitMs,
      highWater,
      acquisition: highWater ? 'pause' : (pending.length >= Math.floor(this.maxItems * 0.75) ? 'slow' : 'normal'),
      activeBatchId: this.activeBatch?.batchId ?? null
    };
  }
}
