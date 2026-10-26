/** Runs `fn`, retrying after a pause when it throws. Rethrows the last error once the attempts are used up. */
export async function retry<T>(
  fn: () => Promise<T>,
  attempts: number,
  delayMs: number,
  onRetry?: (error: Error, attempt: number) => void,
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts) {
        onRetry?.(e as Error, i);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw last;
}
