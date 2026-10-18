/**
 * Replay prevention for webhook event deduplication.
 *
 * Stores processed event IDs in a bounded in-memory map with TTL-based
 * eviction. Events older than the replay window are automatically removed.
 */

export interface ReplayStore {
  has(eventId: string): boolean;
  add(eventId: string): void;
  cleanup(): void;
}

export class MemoryReplayStore implements ReplayStore {
  private entries: Map<string, number> = new Map(); // eventId -> receivedAt (epoch ms)
  private readonly maxCapacity: number;
  private readonly ttlMs: number;

  constructor(options?: { maxCapacity?: number; replayWindowMs?: number }) {
    this.maxCapacity = options?.maxCapacity ?? 10_000;
    this.ttlMs = options?.replayWindowMs ?? 5 * 60 * 1000;
  }

  has(eventId: string): boolean {
    this.cleanup();
    return this.entries.has(eventId);
  }

  add(eventId: string): void {
    this.cleanup();

    // Evict oldest when at capacity
    if (this.entries.size >= this.maxCapacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }

    this.entries.set(eventId, Date.now());
  }

  cleanup(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, receivedAt] of this.entries) {
      if (receivedAt < cutoff) {
        this.entries.delete(id);
      } else {
        break; // Map preserves insertion order; once we find a fresh entry, the rest are newer.
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
