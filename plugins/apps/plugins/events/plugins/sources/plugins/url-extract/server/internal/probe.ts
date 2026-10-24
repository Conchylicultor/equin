import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import { NonRetryableError } from "@plugins/infra/plugins/jobs/server";
import {
  assertResolvesPublic,
  parsePublicUrl,
  safeFetch,
} from "@plugins/infra/plugins/safe-fetch/server";
import { detectBotMitigation } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/core";
import { browserFetch } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/server";
import type {
  ProbeContext,
  ProbeResult,
} from "@plugins/apps/plugins/events/plugins/events-core/server";
import type { UrlFetchMode, UrlSourceConfig } from "../../core";
import { BotChallengeError } from "./bot-challenge";
import { simplifyPageHtml } from "./page-html";
import { extractVisibleText, fingerprintPageText } from "./page-text";
import { readUrlSourceConfig } from "./source-config";

/**
 * A DoS backstop, NOT a content bound: it exists so a URL that turns out to
 * point at a multi-gigabyte file costs a bounded read, and nothing else.
 *
 * It is deliberately far larger than any page's readable text, because a byte
 * offset says nothing about where the content is. The 256 KB this used to be
 * silently cut `fitzroy-paris.com` at byte 262,144 — still 440 KB short of
 * `<body>`, behind ~676 KB of inline Wix `<style>` — so the model was handed the
 * `<title>` alone and correctly answered "no events". The real bound is
 * `MAX_TEXT_CHARS` below.
 */
const MAX_HTML_BYTES = 8 * 1024 * 1024;

/**
 * The bound that actually means something: how much visible text is read.
 * 200k characters is far beyond any real listing page — a page over it is a
 * sign the URL is wrong (an archive, a full-site dump), not a venue's what's-on.
 */
const MAX_TEXT_CHARS = 200_000;

/**
 * The same bound for the simplified markup the model reads, which carries tag
 * overhead on top of the text. Generous — this page reduces 1.25 MB to ~4 KB —
 * and it exists so a pathological tree cannot outgrow the model's context.
 */
const MAX_MODEL_HTML_CHARS = 400_000;

const USER_AGENT = `Mozilla/5.0 (compatible; ${PRODUCT_NAME}-bot/1.0; +events-extractor)`;

/**
 * What `probe` hands `extract`: the page already read, so the expensive phase
 * costs no second fetch.
 *
 * TWO renderings of the same bytes, for two different jobs — do not collapse
 * them into one. `text` is the cheapest stable reading of the page and is what
 * the fingerprint is taken over; `html` keeps the element tree, which is the
 * only thing that says which title, date and venue belong to the SAME event.
 * Fingerprinting `html` instead would fold every attribute's per-request churn
 * into the cache key for no gain.
 */
export interface UrlPagePayload {
  /** The URL after redirects — what the model is told it is reading. */
  url: string;
  /** The normalized visible text the fingerprint was taken over. */
  text: string;
  /** The simplified element tree — what the model actually reads. */
  html: string;
}

/**
 * A page's bytes, however they were obtained — the value that makes the two
 * transports one pipeline.
 *
 * The branch ("plain fetch" vs "start a browser") lives entirely inside
 * `fetchPage`, which returns this; everything downstream — both renderings, all
 * three bounds, the readability guard, the fingerprint — runs on this shape and
 * cannot ask which transport produced it. So starting a browser can change how a
 * page's bytes were obtained and never what the page *means*.
 *
 * Bytes + content-type rather than a decoded string, deliberately: the charset
 * lives on the content-type, which is where both readers already look.
 * Converging on a string here would mean re-implementing charset sniffing for
 * the plain path, and mojibake on every windows-1252 page.
 */
export interface FetchedPage {
  /** The URL after redirects — what the model is told it is reading. */
  url: string;
  bytes: Uint8Array<ArrayBuffer>;
  /** Carries the charset; both readers take it off this. */
  contentType: string;
  /**
   * Which transport read it. For message copy ONLY — never a control-flow
   * input, or the pipeline stops being transport-blind.
   */
  via: "plain" | "browser";
  /** True when what we hold is not the whole page — see `assertWhole`. */
  truncated: boolean;
}

/**
 * The bytes of a capped read, and whether the body had more.
 *
 * `truncated` is reported rather than swallowed because truncated markup parses
 * perfectly well — the rewriter just stops mid-document — so a partial page is
 * silent by default, and a silently partial page is the one failure mode that
 * makes the engine delete the user's events.
 */
export interface CappedBody {
  bytes: Uint8Array<ArrayBuffer>;
  /** True when the body had MORE than `max` bytes: what we hold is partial. */
  truncated: boolean;
}

/**
 * Read at most `max` bytes of the body, then cancel the download.
 *
 * A real bound, not a counter consulted after the fact: the reader is cancelled
 * the moment we have enough, so a URL that turns out to point at a
 * multi-gigabyte file costs `max`.
 *
 * The budget is `max + 1` so that "filled the cap" and "ended exactly at the
 * cap" are distinguishable — without the extra byte, a body that happens to be
 * exactly `max` long is indistinguishable from one that was cut, and the flag
 * would have to guess.
 *
 * Read into bytes rather than piped through a capping `TransformStream` because
 * Bun's `HTMLRewriter.transform()` cannot consume a `Response` whose body is a
 * JS `TransformStream` (`ERR_STREAM_CANNOT_PIPE`, Bun 1.3.13).
 */
export async function readCappedBody(
  body: ReadableStream<Uint8Array>,
  max: number,
): Promise<CappedBody> {
  const budget = max + 1;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  try {
    while (seen < budget) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = budget - seen;
      const slice = value.byteLength <= room ? value : value.subarray(0, room);
      chunks.push(slice);
      seen += slice.byteLength;
    }
  } finally {
    await reader.cancel();
  }

  const truncated = seen > max;
  const length = truncated ? max : seen;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= length) break;
    const slice = chunk.subarray(
      0,
      Math.min(chunk.byteLength, length - offset),
    );
    out.set(slice, offset);
    offset += slice.byteLength;
  }
  return { bytes: out, truncated };
}

/**
 * A 4xx is the user's URL being wrong (a typo, a deleted page, a login wall) —
 * the same request fails identically forever, so it is terminal and parks the
 * source with something actionable on it. 408/429 and every 5xx are the server
 * having a moment: a plain throw, which the refresh job retries.
 *
 * Takes a bare status rather than a `Response` so BOTH transports are judged by
 * the identical rule — a 404 means the same thing whether a socket or a browser
 * reported it. Semantics otherwise unchanged from the `assertFetched` this
 * replaces.
 *
 * A challenge response never reaches this: the mitigation check runs first,
 * because both of this rule's readings are wrong for one. Terminal would park
 * the source claiming the URL is bad, and transient would retry a refusal that
 * has already made up its mind.
 */
function assertStatus(status: number, url: string): void {
  if (status >= 200 && status < 300) return;
  const detail = `${status} fetching ${url}`;
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    throw new NonRetryableError(`Page returned ${detail}`);
  }
  throw new Error(`Page returned ${detail}`);
}

/**
 * The cheap phase: fetch the page and fingerprint what a reader would see.
 *
 * No LLM, no parsing of meaning, no writes. Two halves, deliberately separated:
 * `fetchPage` owns the ONE transport branch, `readPage` owns everything that
 * decides what the page means — and `readPage` touches no network, so that half
 * is unit-testable without a fetch.
 */
export async function probeUrlPage(
  ctx: ProbeContext<UrlSourceConfig>,
): Promise<ProbeResult<UrlPagePayload>> {
  const config = readUrlSourceConfig(ctx.config);
  const target = parsePublicUrl(config.url);
  return readPage(await fetchPage(target, config.fetchMode), target);
}

/**
 * The only place a fetch mode is branched on. Everything after it is blind to
 * the answer.
 *
 * `safeFetch` is mandatory rather than `fetch` on the plain path — it re-resolves
 * and dials the validated IP on every hop, so a source pointed at
 * `http://127.0.0.1` (or a hostname that resolves there a moment later) is
 * refused before a single byte is read, and never reaches the model.
 */
async function fetchPage(
  target: URL,
  mode: UrlFetchMode,
): Promise<FetchedPage> {
  // The user asked for a browser, so there is nothing to try first: a site that
  // challenges every request would otherwise pay for a doomed fetch every tick.
  if (mode === "browser") return renderPage(target);

  const res = await safeFetch(target, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,*/*;q=0.8" },
  });

  // BEFORE `assertStatus`, and the order is the whole point. A bot-mitigation
  // 429 is not rate limiting: shotgun.live answers the very first request to any
  // page in ~200 ms, from a `robots.txt` that says `Allow: /`. Judged by status
  // it retries forever; judged by the evidence it is either escalated to the one
  // client that can read it, or parked with a sentence the user can act on.
  const mitigation = detectBotMitigation(res.status, res.headers);
  if (mitigation) {
    // Nothing downstream reads a challenge page, so let the socket go rather
    // than leaving a body to be collected whenever.
    await res.body?.cancel();
    if (mode === "plain") {
      throw BotChallengeError.inPlainMode(res.status, mitigation);
    }
    return renderPage(target);
  }

  assertStatus(res.status, res.url || target.toString());
  if (!res.body) {
    throw new Error(`Page returned no body: ${target.toString()}`);
  }

  const body = await readCappedBody(res.body, MAX_HTML_BYTES);
  return {
    url: res.url || target.toString(),
    bytes: body.bytes,
    // Carry the content-type through: both readers take the charset off it.
    contentType: res.headers.get("content-type") ?? "text/html",
    via: "plain",
    truncated: body.truncated,
  };
}

/**
 * Read the page the way a person would: a real browser, with the page's own
 * JavaScript run.
 *
 * `assertResolvesPublic` first, as defence in depth. `safeFetch`'s pinned dial
 * protects nothing here — the browser performs its own DNS and follows its own
 * redirects — so this is the last point at which a hostname that has started
 * resolving to a private address is refused by *this* plugin. (The primitive
 * pins the resolver itself; this makes the refusal ours as well as its, and
 * `SsrfError` propagates unwrapped so it still classifies as `blocked_url`.)
 *
 * There is deliberately NO fallback in either direction. A `browserFetch` throw
 * propagates as an ordinary transient failure, and a challenge response is never
 * returned as a page — falling back would convert an infrastructure blip into a
 * page the model reads as an empty listing, which is how the engine is told to
 * bury the user's events.
 */
async function renderPage(target: URL): Promise<FetchedPage> {
  await assertResolvesPublic(target);
  const rendered = await browserFetch(target);

  // A real browser running real JavaScript was refused. Nothing is left to
  // escalate to, so this is where retrying stops being useful.
  if (rendered.status === 403 || rendered.status === 429) {
    // Re-run the predicate on the RENDERED answer: `browserFetch` returns the
    // final headers precisely so "a real browser was refused too" can be stated
    // with the evidence rather than inferred from the first attempt.
    throw BotChallengeError.afterRender(
      rendered.status,
      detectBotMitigation(rendered.status, rendered.headers),
    );
  }
  assertStatus(rendered.status, rendered.url);

  // The browser has already decoded; re-encode to UTF-8 and say so, so the one
  // downstream reader keeps taking the charset off the content-type.
  const bytes = new TextEncoder().encode(
    rendered.html,
  ) as Uint8Array<ArrayBuffer>;
  return {
    url: rendered.url,
    bytes,
    contentType: "text/html; charset=utf-8",
    via: "browser",
    // Honestly weaker than the plain path's bound, and worth saying: there the
    // reader is CANCELLED at the cap, so an enormous page costs `MAX_HTML_BYTES`
    // and no more. Here the primitive's own `maxHtmlBytes` is the real ceiling,
    // and this is a post-hoc check that keeps the assertion and its message in
    // one place rather than a second bound with a second wording.
    truncated: bytes.byteLength > MAX_HTML_BYTES,
  };
}

/**
 * Everything that decides what a page MEANS, with no network in it.
 *
 * That is the point of the split, not a side effect: this is the half that
 * chooses whether a page is safe to hand the model, and it can be exercised over
 * a literal `FetchedPage` in a unit test — including the cases that only ever
 * arrive from a stranger's server.
 */
export async function readPage(
  page: FetchedPage,
  target: URL,
): Promise<ProbeResult<UrlPagePayload>> {
  assertWhole(
    page.truncated,
    `is larger than the ${MAX_HTML_BYTES / 1024 / 1024} MB markup ceiling`,
    target,
  );

  const asResponse = (): Response =>
    new Response(page.bytes, { headers: { "content-type": page.contentType } });

  const text = await extractVisibleText(asResponse(), MAX_TEXT_CHARS);
  assertWhole(
    text.truncated,
    `has more than ${MAX_TEXT_CHARS} characters of visible text`,
    target,
  );
  assertReadable(text.text, page.via, target);

  const html = simplifyPageHtml(await asResponse().text());
  assertWhole(
    html.length > MAX_MODEL_HTML_CHARS,
    `simplifies to more than ${MAX_MODEL_HTML_CHARS} characters of markup`,
    target,
  );

  return {
    // Over the TEXT, never the markup — see `UrlPagePayload`.
    fingerprint: fingerprintPageText(text.text),
    payload: { url: page.url, text: text.text, html },
  };
}

/**
 * A page we could not read WHOLE is a failure, never a shorter page.
 *
 * Continuing with the part we have is the tempting option and the destructive
 * one: the model reads a fragment, returns however many events happen to be in
 * it — often none — and `runSource` then stamps `disappearedAt` on every event
 * this source ever found, because "extracted nothing" is exactly how the engine
 * is told a listing has emptied. `parse-response.ts` refuses to return `[]` for
 * this reason, but a truncated *page* routes around that guard: the model's `[]`
 * is a truthful answer to what it was shown.
 *
 * Terminal rather than transient, on the same reasoning as a 4xx: the identical
 * request truncates identically forever, so retrying it three times buys nothing
 * and the source should park with something a human can act on (fix the URL, or
 * raise the ceiling deliberately).
 */
function assertWhole(truncated: boolean, why: string, target: URL): void {
  if (!truncated) return;
  throw new NonRetryableError(
    `Page ${why} and cannot be read whole: ${target.toString()}`,
  );
}

/**
 * A page with NO readable text at all is a failure, for exactly the reason a
 * truncated one is.
 *
 * Downstream it is indistinguishable from a venue with nothing on: the model is
 * shown an empty page, truthfully answers `{"events": []}`, and `runSource`
 * stamps `disappearedAt` on every event this source ever found — because an
 * empty extraction is precisely how the engine is told a listing has emptied.
 * `parse-response.ts` cannot catch this, and shouldn't: an empty result is a
 * documented legitimate success there.
 *
 * The test is that there is no text, NOT that there is little of it. A threshold
 * ("fewer than N characters ⇒ the page didn't render") would trip on a venue
 * genuinely between seasons, and this file already carries one scar from a
 * length heuristic — see `MAX_HTML_BYTES`. Zero readable characters is a fact.
 *
 * It only ever throws, so it strengthens the never-a-shorter-page invariant
 * rather than trading against it. It also fixes a failure that predates the
 * browser path entirely: an empty plain fetch used to quietly delete the user's
 * events.
 *
 * The remedy differs by transport because the user's next move does:
 * a client-rendered page has one (switch to Browser render), and a page a real
 * browser also renders empty has none we can automate — a cookie or sign-in wall
 * this extractor cannot clear.
 */
function assertReadable(
  text: string,
  via: FetchedPage["via"],
  target: URL,
): void {
  if (text.trim().length > 0) return;
  const remedy =
    via === "plain"
      ? 'Set this source\'s Fetch mode to "Browser render" — a page whose listing is drawn by JavaScript reads as empty to a plain fetch.'
      : "A real browser rendered it and it is still empty — it is behind a cookie or sign-in wall this extractor cannot clear.";
  throw new NonRetryableError(
    `Page has no readable text at all. ${remedy} Page: ${target.toString()}`,
  );
}
