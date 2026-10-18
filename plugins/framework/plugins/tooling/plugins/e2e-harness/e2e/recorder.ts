import { basename, relative } from "node:path";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { toolUseIdFrom } from "@plugins/framework/plugins/tooling/plugins/guards/core";
import { browserRecordingsDir } from "@plugins/debug/plugins/browser-recordings/data-dirs";
import type { RecordingStep } from "@plugins/debug/plugins/browser-recordings/core";
import { openRecording } from "@plugins/debug/plugins/browser-recordings/plugins/writer/core";

export interface Recorder {
  /** Record a context the harness just created: every page it opens is filmed. */
  attach(context: BrowserContext): void;
  /** Film a page that already exists (an attached session's tab). */
  film(page: Page): void;
  /**
   * Stop filming, write the recording and print where it is. Call while the
   * browser is still open — the screencasts are stopped through it.
   */
  finish(): Promise<void>;
}

/**
 * How long after a step's end its frame may still land: the paint an action
 * causes reaches the screencast a beat after the action resolves.
 */
const FRAME_GRACE_MS = 300;

/** JPEG quality of the screencast frames (Playwright's own default). */
const SCREENCAST_QUALITY = 90;

/**
 * Classes whose calls are plumbing, not steps: a route handler's continue /
 * fallback (the harness routes every request — `keepOriginHeadersOnTarget` —
 * so one page load is hundreds of these) and the recorder's own CDP traffic.
 * Matched on the channel class the call reports, since a call made outside the
 * script's own code (a route handler) carries no API name.
 */
const NOT_STEPS = new Set(["Route", "WebSocketRoute", "CDPSession"]);

/**
 * One run's recording, filed under the Bash tool call that launched it: a
 * step per Playwright API call the script made (goto, click, fill, waitFor…),
 * each with the full-resolution frame of the page as the step ended.
 *
 * Steps come from Playwright's client instrumentation — every API call
 * reports its begin and end — so no script declares them. Frames come from a
 * CDP screencast per page (JPEG, at the page's own size): the recorder holds
 * only the latest painted frame, and a step takes the one on screen when it
 * ended (or one painted within {@link FRAME_GRACE_MS}). Nothing here is
 * awaited in the script's path: a `page.screenshot()` per step would either
 * stall every action or race the next one.
 *
 * The env is passed in as data: the run is linked to its tool call by a
 * variable the PreToolUse guard exports (`TOOL_USE_ID_ENV`). It names a
 * transcript row to file the recording under — never which deploy to drive.
 */
export function createRecorder(
  browser: Browser,
  scriptPath: string,
  env: Readonly<Record<string, string | undefined>>,
): Recorder {
  const script = scriptPath.startsWith(REPO_ROOT)
    ? relative(REPO_ROOT, scriptPath)
    : scriptPath;
  const recording = openRecording({
    root: browserRecordingsDir.path,
    toolUseId: toolUseIdFrom(env),
    source: { kind: "e2e", script },
    name: basename(scriptPath).replace(/\.[tj]sx?$/, ""),
  });
  const instrumentation = clientInstrumentation(browser);

  const steps: RecordingStep[] = [];
  const begun = new WeakMap<
    ApiZone,
    { startMs: number; call: string; target?: string } | "plumbing"
  >();
  let latest: Buffer | null = null;
  /** Steps whose frame may still change: their grace has not run out. */
  let open: { step: RecordingStep; image: Buffer | null; until: number }[] = [];
  const writes: Promise<void>[] = [];
  const screencasts: { page: Page; cdp: CDPSession }[] = [];
  const failures: unknown[] = [];

  const seal = (entry: (typeof open)[number]): void => {
    if (entry.image === null) return;
    writes.push(
      recording.frame(entry.image, "jpeg").then((path) => {
        entry.step.frame = path;
      }),
    );
  };
  const onFrame = (image: Buffer): void => {
    latest = image;
    const now = performance.now();
    const still: typeof open = [];
    for (const entry of open) {
      if (now <= entry.until) {
        entry.image = image;
        still.push(entry);
      } else seal(entry);
    }
    open = still;
  };

  const listener: InstrumentationListener = {
    onApiCallBegin(zone, call) {
      if (begun.has(zone)) return;
      begun.set(
        zone,
        // No API name: Playwright found no caller frame, i.e. the call came
        // from a callback (an event or route handler), not the script's flow.
        NOT_STEPS.has(call.type) || !zone.apiName
          ? "plumbing"
          : {
              startMs: recording.elapsedMs(),
              call: zone.apiName,
              target: callTarget(call.params),
            },
      );
    },
    onApiCallEnd(zone) {
      // A call that never reached the browser (no begin) changed nothing on
      // screen; plumbing is not the script's.
      const begin = begun.get(zone);
      if (zone.internal || begin === undefined || begin === "plumbing") return;
      const endMs = recording.elapsedMs();
      const { startMs } = begin;
      const step: RecordingStep = {
        title:
          zone.title ??
          (begin.target !== undefined
            ? `${begin.call} ${begin.target}`
            : begin.call),
        startMs,
        durationMs: endMs - startMs,
        ...(zone.error !== undefined ? { error: zone.error.message } : {}),
      };
      steps.push(step);
      open.push({
        step,
        image: latest,
        until: performance.now() + FRAME_GRACE_MS,
      });
    },
  };
  instrumentation.addListener(listener);

  const film = async (page: Page): Promise<void> => {
    const cdp = await page.context().newCDPSession(page);
    cdp.on("Page.screencastFrame", (frame) => {
      onFrame(Buffer.from(frame.data, "base64"));
      // Chromium sends the next frame only once this one is acknowledged.
      cdp
        .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .catch((err: unknown) => {
          if (!page.isClosed()) failures.push(err);
        });
    });
    // The caps only bound the frame: a page at its own size fits, so frames
    // are full resolution (the viewport in device pixels). JPEG, not PNG:
    // Chromium encodes EVERY painted frame, and PNG encoding a full viewport
    // per paint is heavy enough to slow the run it films; at quality 90 text
    // stays sharp and a frame is several times smaller.
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: SCREENCAST_QUALITY,
      maxWidth: 8192,
      maxHeight: 8192,
    });
    screencasts.push({ page, cdp });
  };
  const filming: Promise<void>[] = [];

  const filmPage = (page: Page): void => {
    filming.push(
      film(page).catch((err: unknown) => {
        // A page closed before its screencast started was never seen.
        if (!page.isClosed()) failures.push(err);
      }),
    );
  };

  return {
    attach(context) {
      context.on("page", filmPage);
    },
    film: filmPage,
    async finish() {
      instrumentation.removeListener(listener);
      const t0 = performance.now();
      await Promise.all(filming);
      for (const { page, cdp } of screencasts) {
        if (page.isClosed()) continue;
        await cdp.send("Page.stopScreencast");
      }
      for (const entry of open) seal(entry);
      open = [];
      await Promise.all(writes);
      if (failures.length > 0) throw failures[0];
      if (steps.length === 0) return;
      await recording.close(steps);
      const frames = new Set(steps.flatMap((s) => (s.frame ? [s.frame] : [])));
      console.log(
        `recording: ${steps.length} steps, ${frames.size} frames in ${Math.round(performance.now() - t0)} ms → ${recording.dir}`,
      );
    },
  };
}

/** The one parameter of a call that says what it acted on, shortened. */
function callTarget(
  params: Record<string, unknown> | undefined,
): string | undefined {
  const p = params ?? {};
  const target = [p.selector, p.url, p.key, p.text, p.expression].find(
    (v): v is string => typeof v === "string",
  );
  if (target === undefined) return undefined;
  return target.length > 120 ? `${target.slice(0, 119)}…` : target;
}

// Playwright's client instrumentation: the hook its own test runner reports
// steps through. It is not in the public types, so it is read here, once, and
// checked — an upgrade that drops it fails the run instead of recording
// nothing.

interface ApiZone {
  apiName?: string;
  title?: string;
  internal: boolean;
  error?: Error;
}
interface InstrumentationListener {
  onApiCallBegin?(
    zone: ApiZone,
    call: { type: string; method: string; params?: Record<string, unknown> },
  ): void;
  onApiCallEnd?(zone: ApiZone): void;
}
interface ClientInstrumentation {
  addListener(listener: InstrumentationListener): void;
  removeListener(listener: InstrumentationListener): void;
}

function clientInstrumentation(browser: Browser): ClientInstrumentation {
  const instrumentation = (browser as unknown as { _instrumentation?: unknown })
    ._instrumentation as Partial<ClientInstrumentation> | undefined;
  if (
    typeof instrumentation?.addListener !== "function" ||
    typeof instrumentation.removeListener !== "function"
  )
    throw new Error(
      "e2e recorder: Playwright's client instrumentation (browser._instrumentation.addListener) is gone — " +
        "adapt e2e-harness/e2e/recorder.ts to this Playwright, or run with --no-record.",
    );
  return instrumentation as ClientInstrumentation;
}
