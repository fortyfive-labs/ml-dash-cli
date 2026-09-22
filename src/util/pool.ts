/**
 * A bounded-concurrency task runner.
 *
 * The Python CLI used `ThreadPoolExecutor(max_workers=N)` for metrics, chunks
 * and files. Node has no threads to pool, but the limit still matters: it is
 * what stops an experiment with 400 metrics from opening 400 sockets at once
 * and having the server start refusing them. Results come back in submission
 * order so a caller can pair them with its inputs; failures are returned, not
 * thrown, because one bad metric must not abandon the rest of the batch.
 */
export async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<{ value?: R; error?: Error }[]> {
  const results: { value?: R; error?: Error }[] = new Array(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { value: await worker(items[index], index) };
      } catch (e) {
        results[index] = { error: e instanceof Error ? e : new Error(String(e)) };
      }
    }
  });

  await Promise.all(runners);
  return results;
}
