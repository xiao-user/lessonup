/**
 * Delivers public run events through one ordered visibility barrier. Durable
 * lifecycle events enter the SSE queue only after their journal write commits;
 * transient deltas remain unpersisted but cannot overtake that barrier.
 */
export class RunEventDispatcher<TEvent> {
  private streamTail = Promise.resolve();
  private persistenceTail = Promise.resolve();
  private readonly failures: unknown[] = [];
  private persistenceFailure: unknown;
  private streamFailure: unknown;

  constructor(
    private readonly write: (event: TEvent) => Promise<void>,
    private readonly persist: ((event: TEvent) => Promise<void>) | undefined,
    private readonly shouldPersist: (event: TEvent) => boolean = () => true,
  ) {}

  dispatch(event: TEvent, delivery?: { persist?: boolean }) {
    const shouldPersist = delivery?.persist !== false && this.persist && this.shouldPersist(event);
    let durable = Promise.resolve();
    if (shouldPersist) {
      durable = this.persistenceTail.then(async () => {
        if (this.persistenceFailure) throw this.persistenceFailure;
        try {
          await this.persist!(event);
        } catch (error) {
          this.persistenceFailure = error;
          this.failures.push(error);
          throw error;
        }
      });
      this.persistenceTail = durable.catch(() => undefined);
    }
    this.streamTail = this.streamTail.then(async () => {
      if (this.streamFailure || this.persistenceFailure) return;
      try {
        await durable;
        if (!this.persistenceFailure) await this.write(event);
      } catch (error) {
        if (error === this.persistenceFailure) return;
        this.streamFailure = error;
        this.failures.push(error);
      }
    });
    return this.streamTail;
  }

  async flush() {
    await Promise.all([this.streamTail, this.persistenceTail]);
    return [...this.failures];
  }
}
