export type AckFailure = { sequence: number; attempts: number; cause: unknown };
type Schedule = (callback: () => void, delayMs: number) => () => void;
const STOPPED = Symbol("terminal-ack-stopped");
const retryDelays = [250, 750] as const;

/** Exact sequence ACKs are idempotent. Keep their xterm completion order,
 * bound both invoke time and retry count, and report a broken transport once. */
export class TerminalAckController {
  private queue: number[] = [];
  private queued = new Set<number>();
  private running = false;
  private disposed = false;
  private cancelPending: (() => void) | null = null;
  private readonly schedule: Schedule;

  constructor(
    private readonly options: {
      send: (sequence: number) => Promise<void>;
      onFailure: (failure: AckFailure) => void;
      schedule?: Schedule;
    },
  ) {
    this.schedule =
      options.schedule ||
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      });
  }

  acknowledge(sequence: number) {
    if (this.disposed || this.queued.has(sequence)) return;
    this.queue.push(sequence);
    this.queued.add(sequence);
    if (!this.running) void this.drain();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.queue = [];
    this.queued.clear();
    this.cancelPending?.();
    this.cancelPending = null;
  }

  private sendWithDeadline(sequence: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let cancelTimer = () => {};
      const finish = (failed: boolean, error?: unknown) => {
        if (settled) return;
        settled = true;
        cancelTimer();
        if (this.cancelPending === cancel) this.cancelPending = null;
        if (failed) reject(error);
        else resolve();
      };
      const cancel = () => finish(true, STOPPED);
      this.cancelPending = cancel;
      cancelTimer = this.schedule(
        () => finish(true, new Error("与桌面后端通信超时")),
        5000,
      );
      // Attach both handlers even after timeout/cancellation so late rejection is consumed.
      Promise.resolve()
        .then(() => {
          if (this.disposed) throw STOPPED;
          return this.options.send(sequence);
        })
        .then(
          () => finish(false),
          (error) => finish(true, error),
        );
    });
  }

  private wait(delayMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let cancelTimer = () => {};
      const finish = (proceed: boolean) => {
        if (settled) return;
        settled = true;
        cancelTimer();
        if (this.cancelPending === cancel) this.cancelPending = null;
        resolve(proceed);
      };
      const cancel = () => finish(false);
      this.cancelPending = cancel;
      cancelTimer = this.schedule(() => finish(!this.disposed), delayMs);
    });
  }

  private async drain() {
    this.running = true;
    try {
      while (!this.disposed && this.queue.length) {
        const sequence = this.queue[0];
        let cause: unknown;
        let succeeded = false;
        for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
          try {
            await this.sendWithDeadline(sequence);
            if (this.disposed) return;
            succeeded = true;
            break;
          } catch (error) {
            if (this.disposed || error === STOPPED) return;
            cause = error;
          }
          if (
            attempt < retryDelays.length &&
            !(await this.wait(retryDelays[attempt]))
          )
            return;
        }
        if (!succeeded) {
          this.dispose();
          this.options.onFailure({
            sequence,
            attempts: retryDelays.length + 1,
            cause,
          });
          return;
        }
        this.queue.shift();
        this.queued.delete(sequence);
      }
    } finally {
      this.running = false;
    }
  }
}
