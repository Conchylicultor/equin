/**
 * Await `work`, for at most `budgetMs`.
 *
 * For an await that carries no timeout option of its own — a module import, a
 * promise a bug may never settle. On expiry it rejects with `onTimeout()`: the
 * caller supplies the error, so this helper never invents a classification it
 * cannot justify. When `work` rejects first, its own error wins, so a failure
 * stays distinguishable from a slow success.
 *
 * What it deliberately does NOT do is cancel `work`. There is often nothing to
 * cancel (a module import has no abort), and pretending otherwise would be the
 * lie. The caller keeps its own handle on `work` and decides what a
 * still-in-flight promise means — browser-fetch's `loadPlaywright` keeps its
 * memo, so the abandoned import is never orphaned and never started twice.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  budgetMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), budgetMs);
      }),
    ]);
  } finally {
    // Always cleared, on every path: a live timer would hold the event loop open
    // for the rest of the budget after a fast success.
    clearTimeout(timer);
  }
}
