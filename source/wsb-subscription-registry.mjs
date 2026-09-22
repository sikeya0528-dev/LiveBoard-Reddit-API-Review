const clean = value => String(value ?? '').trim();
const threadName = value => {
  const raw = clean(value);
  if (!raw) throw new Error('wsb_subscription_thread_missing');
  return raw.startsWith('t3_') ? raw : `t3_${raw}`;
};

export class WsbSubscriptionRegistry {
  constructor() {
    this.byThread = new Map();
    this.byPane = new Map();
    this.serial = 0;
  }

  attach(paneId, threadFullname) {
    const pane = clean(paneId);
    if (!pane) throw new Error('wsb_subscription_pane_missing');
    const thread = threadName(threadFullname);
    const priorThread = this.byPane.get(pane);
    if (priorThread && priorThread !== thread) this.detach(pane);
    let sub = this.byThread.get(thread);
    if (!sub) {
      sub = { id: `wsb-sub-${++this.serial}`, thread, panes: new Set(), generation: 1, active: true };
      this.byThread.set(thread, sub);
    }
    sub.panes.add(pane);
    sub.active = true;
    this.byPane.set(pane, thread);
    return this.#view(sub);
  }

  detach(paneId) {
    const pane = clean(paneId);
    const thread = this.byPane.get(pane);
    if (!thread) return null;
    const sub = this.byThread.get(thread);
    this.byPane.delete(pane);
    if (!sub) return null;
    sub.panes.delete(pane);
    if (sub.panes.size === 0) {
      sub.active = false;
      this.byThread.delete(thread);
    }
    return this.#view(sub);
  }

  bumpGeneration(threadFullname) {
    const thread = threadName(threadFullname);
    const sub = this.byThread.get(thread);
    if (!sub) return null;
    sub.generation += 1;
    return this.#view(sub);
  }

  lookupByPane(paneId) {
    const thread = this.byPane.get(clean(paneId));
    const sub = thread ? this.byThread.get(thread) : null;
    return sub ? this.#view(sub) : null;
  }

  #view(sub) {
    return Object.freeze({ id: sub.id, thread: sub.thread, refCount: sub.panes.size, generation: sub.generation, active: sub.active, panes: Object.freeze([...sub.panes].sort()) });
  }

  snapshot() { return Object.freeze([...this.byThread.values()].map(sub => this.#view(sub))); }
}
