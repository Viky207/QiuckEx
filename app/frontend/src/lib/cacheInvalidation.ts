/**
 * Resilient Cache Invalidation Service for QuickEx Frontend.
 *
 * Coordinates cache invalidation across open tabs and component lifecycles
 * after payment-link creation and on-chain payment completion.
 * Employs BroadcastChannel with window storage and in-memory pub-sub fallback.
 */

export type InvalidationEventType =
  | "link_created"
  | "payment_completed"
  | "payment_status_changed"
  | "activity_feed_cleared"
  | "account_switched";

export interface CacheInvalidationEvent {
  type: InvalidationEventType;
  timestamp: number;
  payload?: {
    linkId?: string;
    username?: string;
    txHash?: string;
    amount?: string;
    asset?: string;
    state?: string;
    publicKey?: string;
  };
}

type InvalidationListener = (event: CacheInvalidationEvent) => void;

const CHANNEL_NAME = "quickex:cache-invalidation";
const STORAGE_SYNC_KEY = "quickex:last-cache-invalidation";

class ResilientCacheInvalidator {
  private channel: BroadcastChannel | null = null;
  private listeners: Set<InvalidationListener> = new Set();
  private lastInvalidationTimes: Map<InvalidationEventType, number> = new Map();

  constructor() {
    if (typeof window !== "undefined") {
      // 1. Setup BroadcastChannel if supported
      try {
        if ("BroadcastChannel" in window) {
          this.channel = new BroadcastChannel(CHANNEL_NAME);
          this.channel.onmessage = (event: MessageEvent<CacheInvalidationEvent>) => {
            if (event.data && event.data.type) {
              this.notifyLocalListeners(event.data);
            }
          };
        }
      } catch {
        this.channel = null;
      }

      // 2. Storage event listener as multi-tab fallback
      window.addEventListener("storage", (e: StorageEvent) => {
        if (e.key === STORAGE_SYNC_KEY && e.newValue) {
          try {
            const parsed = JSON.parse(e.newValue) as CacheInvalidationEvent;
            if (parsed && parsed.type) {
              this.notifyLocalListeners(parsed);
            }
          } catch {
            // Ignore malformed storage sync
          }
        }
      });
    }
  }

  /**
   * Broadcast a cache invalidation event across components and tabs.
   * Resilient to network/storage exceptions.
   */
  public invalidate(
    type: InvalidationEventType,
    payload?: CacheInvalidationEvent["payload"],
  ): void {
    const event: CacheInvalidationEvent = {
      type,
      timestamp: Date.now(),
      payload,
    };

    this.lastInvalidationTimes.set(type, event.timestamp);

    // 1. Notify local subscribers
    this.notifyLocalListeners(event);

    // 2. Broadcast via BroadcastChannel
    try {
      this.channel?.postMessage(event);
    } catch {
      // BroadcastChannel failed, fallback to localStorage
    }

    // 3. Write to localStorage for multi-tab fallback & persistence
    if (typeof window !== "undefined" && window.localStorage) {
      try {
        localStorage.setItem(STORAGE_SYNC_KEY, JSON.stringify(event));
      } catch {
        // LocalStorage quota or access error in private browsing
      }
    }
  }

  /**
   * Register a listener for cache invalidation events.
   * Returns an unsubscribe function.
   */
  public subscribe(listener: InvalidationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Get timestamp of the last invalidation for a specific event type.
   */
  public getLastInvalidationTime(type: InvalidationEventType): number | undefined {
    return this.lastInvalidationTimes.get(type);
  }

  private notifyLocalListeners(event: CacheInvalidationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("Error in cache invalidation listener:", err);
      }
    }
  }
}

export const cacheInvalidator = new ResilientCacheInvalidator();

/**
 * Convenience helper to trigger cache invalidation after a link is created.
 */
export function notifyLinkCreated(params?: {
  linkId?: string;
  username?: string;
}): void {
  cacheInvalidator.invalidate("link_created", params);
}

/**
 * Convenience helper to trigger cache invalidation after an on-chain payment completes.
 */
export function notifyPaymentCompleted(params: {
  txHash: string;
  username: string;
  amount?: string;
  asset?: string;
}): void {
  cacheInvalidator.invalidate("payment_completed", params);
}
