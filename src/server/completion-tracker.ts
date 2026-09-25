export class CompletionTracker {
  private readonly working = new Set<string>();
  private readonly removalTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly reconnectGraceMs = 30_000) {}

  connected(instanceId: string, idle: boolean): boolean {
    this.cancelRemoval(instanceId);
    if (!idle) {
      this.working.add(instanceId);
      return false;
    }
    return this.working.delete(instanceId);
  }

  started(instanceId: string): void {
    this.cancelRemoval(instanceId);
    this.working.add(instanceId);
  }

  settled(instanceId: string): boolean {
    this.cancelRemoval(instanceId);
    return this.working.delete(instanceId);
  }

  disconnected(instanceId: string): void {
    this.cancelRemoval(instanceId);
    const timer = setTimeout(() => {
      this.removalTimers.delete(instanceId);
      this.working.delete(instanceId);
    }, this.reconnectGraceMs);
    timer.unref();
    this.removalTimers.set(instanceId, timer);
  }

  dispose(): void {
    for (const timer of this.removalTimers.values()) clearTimeout(timer);
    this.removalTimers.clear();
    this.working.clear();
  }

  private cancelRemoval(instanceId: string): void {
    const timer = this.removalTimers.get(instanceId);
    if (timer) clearTimeout(timer);
    this.removalTimers.delete(instanceId);
  }
}
