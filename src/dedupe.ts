/**
 * TTL-based seen-key cache with a hard size cap.
 * Map preserves insertion order, so the first entries are always the oldest.
 */
export class DedupeCache {
  private readonly seen = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 100_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!(ttlMs > 0)) throw new Error("dedupe ttl must be > 0");
  }

  /** Returns true if the key is new (and marks it), false if already seen. */
  checkAndMark(key: string): boolean {
    const t = this.now();
    const exp = this.seen.get(key);
    if (exp !== undefined && exp > t) return false;
    if (exp !== undefined) this.seen.delete(key);
    this.seen.set(key, t + this.ttlMs);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }

  has(key: string): boolean {
    const exp = this.seen.get(key);
    return exp !== undefined && exp > this.now();
  }

  /** Remove expired keys. Entries are in insertion order with equal TTL, so stop at first live one. */
  sweep(): number {
    const t = this.now();
    let removed = 0;
    for (const [k, exp] of this.seen) {
      if (exp > t) break;
      this.seen.delete(k);
      removed++;
    }
    return removed;
  }

  get size(): number {
    return this.seen.size;
  }

  startSweeper(intervalMs = 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref();
  }

  stopSweeper(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }
}

export function ethDedupeKey(txHash: string, vaultAddress: string): string {
  return `Ethereum|${txHash.toLowerCase()}|${vaultAddress.toLowerCase()}`;
}

export function zigDedupeKey(txHash: string, messageIndex: number, vaultAddress: string): string {
  return `ZigChain|${txHash.toUpperCase()}|${messageIndex}|${vaultAddress}`;
}
