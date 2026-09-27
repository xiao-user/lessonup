/**
 * Coalesces high-frequency streamed text into bounded durable checkpoints.
 * The browser still receives every safe delta immediately; this only prevents
 * a remote database write per token from extending a completed Agent turn.
 */
export function createMessageCheckpoint(args: {
  persist: (content: string) => Promise<unknown>;
  delayMs?: number;
}) {
  const delayMs = args.delayMs ?? 300;
  let latest: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drain: Promise<void> | undefined;

  const beginDrain = () => {
    if (drain || latest === undefined) return;
    const content = latest;
    latest = undefined;
    drain = args.persist(content)
      .then(() => undefined)
      // A terminal settle writes the final snapshot too. An intermediate
      // checkpoint failure must not interrupt the visible stream.
      .catch(() => undefined)
      .finally(() => {
        drain = undefined;
        if (latest !== undefined) schedule();
      });
  };

  const schedule = () => {
    if (timer || drain || latest === undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      beginDrain();
    }, delayMs);
  };

  return {
    update(content: string) {
      latest = content;
      schedule();
    },
    async flush(content: string) {
      latest = content;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      while (latest !== undefined || drain) {
        beginDrain();
        if (drain) await drain;
      }
    },
  };
}
