/**
 * Where record MISSES are computed: in this process, or spread over worker
 * threads. A record is a pure function of its key, so which thread made it
 * cannot change it — the only thing a pool changes is how many cores a cold
 * store (a new machine, an edit to a facet or the evaluator) keeps busy.
 *
 * A JOB is a named function of plain data (`defineRecordJob`), defined at the
 * top level of the module that owns the work. A worker answers a request by
 * importing that module (its entry's own `import`) and running the job it
 * registered, so the code that runs in a worker is exactly the code that runs
 * in-process — there is no
 * second implementation to drift. Requests and replies are structured-cloned:
 * plain data only, never a handle.
 *
 * Workers never touch the record store: they hand the records they made back,
 * and the caller stores them. So a pooled run and an in-process one write the
 * same rows to whatever store the process installed (the shared SQLite one, or
 * a check pass's memory store).
 *
 * The pool is the host process's to install (`installRecordWorkers`, with the
 * `cli/` implementation); a process that installs none runs every job
 * in-process, one after another.
 */

export interface RecordJob<Req, Rep> {
  /** `<module url>#<name>`: what a worker imports and looks up. */
  readonly id: string;
  run(request: Req): Promise<Rep>;
}

/** What a worker is sent: the job's id and its request. */
export interface RecordJobRequest {
  id: string;
  request: unknown;
}

export interface RecordWorkers {
  /** How many jobs run at once. */
  readonly size: number;
  run(request: RecordJobRequest): Promise<unknown>;
}

const jobs = new Map<string, RecordJob<unknown, unknown>>();

/**
 * Define a job. `module` is the defining module's `import.meta.url`; call it
 * once, at that module's top level, so importing the module registers it.
 */
export function defineRecordJob<Req, Rep>(
  module: string,
  name: string,
  run: (request: Req) => Promise<Rep>,
): RecordJob<Req, Rep> {
  const id = `${module}#${name}`;
  if (jobs.has(id))
    throw new Error(`[plugin-records] record job ${id} is defined twice`);
  const job: RecordJob<Req, Rep> = { id, run };
  jobs.set(id, job as RecordJob<unknown, unknown>);
  return job;
}

/**
 * The worker half: run the job a request names, loading its module first with
 * `load` — the worker entry's own `import` (`bin/record-worker.ts`). The load
 * by computed path is the worker's, never this barrel's: every process that
 * imports `core` (a serving backend, through the plugin tree) would otherwise
 * carry a load `sourceDigest` cannot follow, for a step only a worker runs.
 */
export async function runRecordJobRequest(
  req: RecordJobRequest,
  load: (module: string) => Promise<unknown>,
): Promise<unknown> {
  let job = jobs.get(req.id);
  if (!job) {
    const hash = req.id.lastIndexOf("#");
    await load(req.id.slice(0, hash));
    job = jobs.get(req.id);
    if (!job)
      throw new Error(
        `[plugin-records] ${req.id.slice(0, hash)} defines no record job "${req.id.slice(hash + 1)}"`,
      );
  }
  return job.run(req.request);
}

let installed: RecordWorkers | undefined;

/** Install the pool this process's record misses run on. */
export function installRecordWorkers(workers: RecordWorkers | undefined): void {
  installed = workers;
}

/**
 * How many workers a batch of misses may spread over: the installed pool's
 * size, or 1 (in-process). A caller splits its misses into at most this many
 * requests, and only when there are enough of them to pay a worker's start.
 */
export function recordWorkerCount(): number {
  return installed?.size ?? 1;
}

/**
 * Run `job` once per request, on the installed pool when there is one and
 * more than one request, else in this process one after another. Replies come
 * back in request order.
 */
export async function runRecordJobs<Req, Rep>(
  job: RecordJob<Req, Rep>,
  requests: readonly Req[],
): Promise<Rep[]> {
  const pool = installed;
  if (!pool || requests.length < 2) {
    const out: Rep[] = [];
    for (const r of requests) out.push(await job.run(r));
    return out;
  }
  return Promise.all(
    requests.map(
      async (request) => (await pool.run({ id: job.id, request })) as Rep,
    ),
  );
}
