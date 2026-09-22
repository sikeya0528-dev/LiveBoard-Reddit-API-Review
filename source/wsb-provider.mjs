import { assertApprovedRedditConfig } from './wsb-reddit-contract.mjs';
import { buildWsbReadRequest, rankWsbCandidates, WsbThreadSwitchAdvisor, WSB_STAGE08_LIMITS } from './wsb-provider-core.mjs';
import { WsbFlatStream } from './wsb-flat-stream.mjs';
import { WsbRateBudget } from './wsb-rate-budget.mjs';
import { WsbSubscriptionRegistry } from './wsb-subscription-registry.mjs';
import { WsbTranslationQueue } from './wsb-translation-queue.mjs';

export class WsbProvider {
  constructor({ redditConfig = null, now = () => Date.now() } = {}) {
    this.redditConfig = redditConfig ? assertApprovedRedditConfig(redditConfig) : null;
    this.rawRedditConfig = redditConfig;
    this.now = now;
    this.rateBudget = new WsbRateBudget({ maxPerMinute: WSB_STAGE08_LIMITS.initialRequestBudgetPerMinute, now });
    this.subscriptions = new WsbSubscriptionRegistry();
    this.shared = new Map();
    this.switchAdvisors = new Map();
  }

  liveAccessReady() { return Boolean(this.redditConfig); }

  buildRequest(args) {
    if (!this.rawRedditConfig) throw new Error('reddit_api_approval_required');
    return buildWsbReadRequest(this.rawRedditConfig, args);
  }

  rankCandidates(args) { return rankWsbCandidates(args); }

  observeSwitch(paneId, { currentId, ranked, mode } = {}) {
    const key = String(paneId ?? '');
    let advisor = this.switchAdvisors.get(key);
    if (!advisor) {
      advisor = new WsbThreadSwitchAdvisor();
      this.switchAdvisors.set(key, advisor);
    }
    return advisor.observe({ currentId, ranked, mode });
  }

  subscribe(paneId, threadFullname) {
    const sub = this.subscriptions.attach(paneId, threadFullname);
    let shared = this.shared.get(sub.id);
    if (!shared) {
      shared = {
        id: sub.id,
        thread: sub.thread,
        generation: sub.generation,
        stream: new WsbFlatStream({ threadFullname: sub.thread, generation: sub.generation, maxRetained: WSB_STAGE08_LIMITS.maxRetainedPerPane }),
        translation: new WsbTranslationQueue({
          generation: sub.generation,
          maxItems: WSB_STAGE08_LIMITS.translationQueueMax,
          highWaterMs: WSB_STAGE08_LIMITS.translationHighWaterMs,
          timeoutMs: WSB_STAGE08_LIMITS.translationTimeoutMs,
          retries: WSB_STAGE08_LIMITS.translationRetries,
          batchMaxItems: WSB_STAGE08_LIMITS.translationBatchItems,
          batchMaxChars: WSB_STAGE08_LIMITS.translationBatchChars,
          commitMinIntervalMs: WSB_STAGE08_LIMITS.rendererCommitMinIntervalMs,
          commitMaxItems: WSB_STAGE08_LIMITS.rendererCommitMaxItems
        })
      };
      this.shared.set(sub.id, shared);
    }
    return Object.freeze({ subscription: sub, stream: shared.stream, translation: shared.translation });
  }

  unsubscribe(paneId) {
    const before = this.subscriptions.lookupByPane(paneId);
    const result = this.subscriptions.detach(paneId);
    if (before && result?.refCount === 0) this.shared.delete(before.id);
    this.switchAdvisors.delete(String(paneId ?? ''));
    return result;
  }

  sharedStateForPane(paneId) {
    const sub = this.subscriptions.lookupByPane(paneId);
    if (!sub) return null;
    const shared = this.shared.get(sub.id);
    return shared ? Object.freeze({ subscription: sub, stream: shared.stream, translation: shared.translation }) : null;
  }

  applyContentChecks(paneId, records) {
    const state = this.sharedStateForPane(paneId);
    if (!state) throw new Error('wsb_subscription_missing');
    const result = state.stream.applyContentChecks(records, { generation: state.subscription.generation });
    for (const id of result.removed ?? []) state.translation.removeComment(id);
    return result;
  }

  bumpGenerationForPane(paneId) {
    const state = this.sharedStateForPane(paneId);
    if (!state) throw new Error('wsb_subscription_missing');
    const sub = this.subscriptions.bumpGeneration(state.subscription.thread);
    const shared = this.shared.get(sub.id);
    shared.generation = sub.generation;
    shared.stream.switchThread(sub.thread);
    shared.translation.setGeneration(sub.generation);
    return sub.generation;
  }

  pollDecision(paneId, now = this.now()) {
    const state = this.sharedStateForPane(paneId);
    if (!state) return Object.freeze({ action: 'stopped', reason: 'no-subscription' });
    const queue = state.translation.status(now);
    if (queue.highWater || state.stream.snapshot().pausedForRetention) return Object.freeze({ action: 'pause', reason: queue.highWater ? 'translation-backpressure' : 'retention-anchor', queue });
    const rate = this.rateBudget.status(now);
    if (!rate.allowed) return Object.freeze({ action: 'wait', reason: 'rate-budget', nextAllowedAt: rate.nextAllowedAt, queue, rate });
    return Object.freeze({ action: queue.acquisition === 'slow' ? 'slow' : 'poll', queue, rate });
  }
}
