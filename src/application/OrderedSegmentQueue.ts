export interface SegmentDescriptor {
  index: number;
  path: string;
}

export interface SegmentQueueStats {
  nextExpectedIndex: number;
  queuedIndexes: number[];
  inFlightIndex: number | null;
}

type CommitHandler = (segment: SegmentDescriptor) => Promise<void>;

export class OrderedSegmentQueue {
  private readonly pending = new Map<number, SegmentDescriptor>();
  private processing = false;
  private inFlightIndex: number | null = null;
  private readonly idleResolvers = new Set<() => void>();
  private failure: Error | null = null;

  constructor(private readonly commit: CommitHandler, private nextExpectedIndex = 0) {}

  enqueue(segments: SegmentDescriptor[]) {
    for (const segment of segments) {
      if (segment.index < this.nextExpectedIndex) continue;
      if (segment.index === this.inFlightIndex) continue;
      if (this.pending.has(segment.index)) continue;
      this.pending.set(segment.index, segment);
    }
    void this.process();
  }

  getStats(): SegmentQueueStats {
    return {
      nextExpectedIndex: this.nextExpectedIndex,
      queuedIndexes: [...this.pending.keys()].sort((left, right) => left - right),
      inFlightIndex: this.inFlightIndex,
    };
  }

  async whenIdle(): Promise<void> {
    if (!this.processing && this.pending.size === 0) {
      if (this.failure) throw this.failure;
      return;
    }

    await new Promise<void>((resolve) => {
      this.idleResolvers.add(resolve);
    });

    if (this.failure) throw this.failure;
  }

  private async process() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.pending.has(this.nextExpectedIndex)) {
        const segment = this.pending.get(this.nextExpectedIndex);
        if (!segment) break;
        this.pending.delete(this.nextExpectedIndex);
        this.inFlightIndex = segment.index;
        await this.commit(segment);
        this.inFlightIndex = null;
        this.nextExpectedIndex += 1;
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      this.processing = false;
      this.inFlightIndex = null;
      if (this.pending.size === 0 || this.failure) {
        for (const resolve of this.idleResolvers) resolve();
        this.idleResolvers.clear();
      }
    }
  }
}
