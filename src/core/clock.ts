/** Timers that never keep pi alive on their own: a print-mode run exits when its work is done. */

export type Timer = { cancel(): void };

export type Clock = {
  now(): number;
  after(milliseconds: number, run: () => unknown): Timer;
  sleep(milliseconds: number, options?: { signal?: AbortSignal }): Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  after(milliseconds, run) {
    const timer = setTimeout(
      () => {
        // A timer's work reports its own failures; an escaped rejection must not crash pi.
        void Promise.resolve()
          .then(run)
          .catch(() => {});
      },
      Math.max(0, milliseconds),
    );
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
  sleep(milliseconds, options = {}) {
    const { signal } = options;
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("sleep cancelled"));
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", cancel);
          resolve();
        },
        Math.max(0, milliseconds),
      );
      timer.unref?.();
      const cancel = () => {
        clearTimeout(timer);
        reject(new Error("sleep cancelled"));
      };
      signal?.addEventListener("abort", cancel, { once: true });
    });
  },
};
