import type { ServerEvent } from '@aq/shared';

/**
 * In-process fan-out for live console updates.
 *
 * Deliberately tiny and synchronous: the trader loop publishes, the HTTP layer
 * subscribes per WebSocket client. A slow subscriber must never be able to stall
 * the trading loop, so delivery is fire-and-forget and bounded.
 */
export class EventBus {
  private readonly subscribers = new Set<(event: ServerEvent) => void>();
  /** Ring buffer of recent events so a freshly-connected console sees context. */
  private readonly recent: ServerEvent[] = [];
  private static readonly RECENT_LIMIT = 200;

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  publish(event: ServerEvent): void {
    this.recent.push(event);
    if (this.recent.length > EventBus.RECENT_LIMIT) this.recent.shift();

    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // A broken subscriber is its own problem; never let it break the loop.
      }
    }
  }

  /** Most recent events, oldest first. */
  history(limit = 50): ServerEvent[] {
    return this.recent.slice(-limit);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

export const eventBus = new EventBus();
