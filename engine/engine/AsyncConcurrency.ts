/**
 * Run `fn` over `items` with at most `limit` tasks in flight at once. Results are
 * returned in **input order** regardless of which task finishes first — callers
 * that depend on ordering (e.g. first-wins animation overrides) stay correct.
 *
 * `fn` should not throw if one failure must not abort the whole batch: catch
 * inside and return a sentinel (e.g. `null`). A throw rejects the returned
 * promise like `Promise.all`.
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    if (items.length === 0) return results;

    let cursor = 0;
    const workerCount = Math.max(1, Math.min(limit, items.length));
    const runWorker = async (): Promise<void> => {
        // `cursor++` reads-then-increments with no await in between, so each
        // worker claims a distinct index even though several run concurrently.
        for (let i = cursor++; i < items.length; i = cursor++) {
            results[i] = await fn(items[i]!, i);
        }
    };
    await Promise.all(Array.from({ length: workerCount }, runWorker));
    return results;
}
