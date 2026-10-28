import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  HooktheoryApiError,
  HooktheoryNotSignedInError,
  HooktheoryProviderUnavailableError,
  HooktheorySectionNotFoundError,
} from "../../core";
import { getTheorytabSection, getTrendNodes, getTrendSongs } from "./client";
import {
  LET_IT_BE_VERSE,
  TRENDS_NODES_401_HTML,
  UNKNOWN_SECTION_400_JSON,
} from "../../core/testing";
import { hooktheoryErrorText } from "./request";

describe("hooktheoryErrorText", () => {
  it("returns the message of Hooktheory's JSON envelope", () => {
    expect(hooktheoryErrorText(400, UNKNOWN_SECTION_400_JSON)).toBe(
      "The provided hash 1 could not be decoded",
    );
  });

  it("never quotes an HTML error page — only its title", () => {
    const text = hooktheoryErrorText(401, TRENDS_NODES_401_HTML);
    expect(text).toBe(
      "Hooktheory request failed (HTTP 401): Unauthorized (#401)",
    );
    expect(text).not.toContain("<");
  });

  it("falls back to the status for an empty body or an HTML page with no title", () => {
    expect(hooktheoryErrorText(502, "")).toBe(
      "Hooktheory request failed (HTTP 502)",
    );
    expect(hooktheoryErrorText(500, "<html><body>oops</body></html>")).toBe(
      "Hooktheory request failed (HTTP 500)",
    );
  });

  it("quotes plain text, cut to a readable length", () => {
    expect(hooktheoryErrorText(429, "Slow down")).toBe(
      "Hooktheory request failed (HTTP 429): Slow down",
    );
    const long = hooktheoryErrorText(500, "x".repeat(1000));
    expect(long.length).toBeLessThan(260);
    expect(long.endsWith("…")).toBe(true);
  });

  it("quotes a JSON body that is not the envelope instead of dropping it", () => {
    expect(hooktheoryErrorText(500, '{"error":"boom"}')).toBe(
      'Hooktheory request failed (HTTP 500): {"error":"boom"}',
    );
  });
});

// ── The client over a stubbed fetch: no call leaves the machine ─────────────

const realFetch = globalThis.fetch;

/**
 * A faked UPSTREAM reply (central's token bridge, or Hooktheory) — spelled as a
 * plain `new Response` because it stands in for a remote server, not one of
 * our endpoint handlers.
 */
function jsonReply(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

interface Call {
  url: string;
  headers: Headers;
}

/**
 * Install a fetch that answers central's token bridge with `token` and every
 * Hooktheory call with `hooktheory`, recording each request.
 */
function stubFetch(opts: { token?: unknown; hooktheory: () => Response }) {
  const calls: Call[] = [];
  const fn = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    if (url.endsWith("/api/auth/token")) {
      if (opts.token === undefined) {
        throw new Error("token bridge called by a public request");
      }
      return Promise.resolve(jsonReply(opts.token));
    }
    if (!url.startsWith("https://api.hooktheory.com/v1/")) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    return Promise.resolve(opts.hooktheory());
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return calls;
}

const SIGNED_IN = {
  ok: true,
  accessToken: "activkey-123",
  expiresAt: Number.MAX_SAFE_INTEGER,
  scopes: [],
  identity: { accountId: "primary", displayName: "someone" },
};

/** Await `p` and return what it rejected with; throw if it resolved. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("getTheorytabSection", () => {
  it("fetches the public section with no token and decodes it", async () => {
    const calls = stubFetch({
      hooktheory: () => jsonReply(LET_IT_BE_VERSE),
    });
    const section = await getTheorytabSection("_NgbRXeYgQA");
    expect(section.chords).toHaveLength(12);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/songs/public/_NgbRXeYgQA");
    expect(url.searchParams.get("fields")).toBe("ID,song,jsonData");
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("names Hooktheory's 400 for an unknown id as not-found", async () => {
    stubFetch({
      hooktheory: () => new Response(UNKNOWN_SECTION_400_JSON, { status: 400 }),
    });
    const err = await rejection(getTheorytabSection("zzzzzzzzzzz"));
    expect(err).toBeInstanceOf(HooktheorySectionNotFoundError);
    expect((err as HooktheorySectionNotFoundError).sectionId).toBe(
      "zzzzzzzzzzz",
    );
  });

  it("keeps any other non-2xx a plain HooktheoryApiError", async () => {
    stubFetch({
      hooktheory: () => new Response("", { status: 503 }),
    });
    const err = await rejection(getTheorytabSection("_NgbRXeYgQA"));
    expect(err).toBeInstanceOf(HooktheoryApiError);
    expect(err).not.toBeInstanceOf(HooktheorySectionNotFoundError);
    expect((err as HooktheoryApiError).status).toBe(503);
  });

  it("refuses an id that could leave the section path, before any request", async () => {
    const calls = stubFetch({ hooktheory: () => jsonReply({}) });
    expect(await rejection(getTheorytabSection(".."))).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
  });

  it("throws naming the field when a 2xx body has the wrong shape", async () => {
    stubFetch({ hooktheory: () => jsonReply({ ID: 1, song: "x" }) });
    const err = await rejection(getTheorytabSection("_NgbRXeYgQA"));
    expect((err as Error).message).toMatch(
      /Hooktheory \/songs\/public\/_NgbRXeYgQA response did not match the expected shape — jsonData: /,
    );
  });
});

describe("signed-in calls", () => {
  it("sends the account's token as a Bearer header and renames the node fields", async () => {
    const calls = stubFetch({
      token: SIGNED_IN,
      hooktheory: () =>
        jsonReply([
          {
            chord_ID: "5",
            chord_HTML: "V",
            probability: 0.31,
            child_path: "1,4,5",
          },
        ]),
    });
    expect(await getTrendNodes(["1", "4"])).toEqual([
      { chordId: "5", chordHtml: "V", probability: 0.31, childPath: "1,4,5" },
    ]);
    const hooktheoryCall = calls.find((c) => c.url.includes("hooktheory.com"));
    expect(hooktheoryCall?.headers.get("authorization")).toBe(
      "Bearer activkey-123",
    );
    expect(new URL(hooktheoryCall?.url ?? "").searchParams.get("cp")).toBe(
      "1,4",
    );
  });

  it("omits cp for an empty progression", async () => {
    const calls = stubFetch({
      token: SIGNED_IN,
      hooktheory: () => jsonReply([]),
    });
    await getTrendNodes([]);
    const hooktheoryCall = calls.find((c) => c.url.includes("hooktheory.com"));
    expect(new URL(hooktheoryCall?.url ?? "").searchParams.has("cp")).toBe(
      false,
    );
  });

  it("throws HooktheoryNotSignedInError when there is no account", async () => {
    const calls = stubFetch({
      token: { ok: false, needsConsent: true, reason: "no-account" },
      hooktheory: () => jsonReply([]),
    });
    const err = await rejection(getTrendSongs(["1", "5"], 1));
    expect(err).toBeInstanceOf(HooktheoryNotSignedInError);
    expect((err as Error).message).toBe(
      "Sign in to Hooktheory in Settings → Accounts",
    );
    expect(calls.some((c) => c.url.includes("hooktheory.com"))).toBe(false);
  });

  it("throws loudly when central does not know the provider", async () => {
    stubFetch({
      token: {
        ok: false,
        message: 'Auth: unknown provider "hooktheory"',
        code: "unknown-provider",
      },
      hooktheory: () => jsonReply([]),
    });
    const err = await rejection(getTrendNodes(["1"]));
    // Not a sign-in problem: signing in is not the way out of it.
    expect(err).not.toBeInstanceOf(HooktheoryNotSignedInError);
    expect(err).toBeInstanceOf(HooktheoryProviderUnavailableError);
    expect((err as Error).message).toMatch(/unknown provider "hooktheory"/);
  });

  it("tells the user to sign in again when Hooktheory refuses the token", async () => {
    stubFetch({
      token: SIGNED_IN,
      hooktheory: () =>
        new Response(TRENDS_NODES_401_HTML, {
          status: 401,
          headers: { "content-type": "text/html; charset=UTF-8" },
        }),
    });
    const err = await rejection(getTrendNodes(["1", "4"]));
    expect(err).toBeInstanceOf(HooktheoryApiError);
    expect((err as HooktheoryApiError).status).toBe(401);
    expect((err as Error).message).toBe(
      "Hooktheory request failed (HTTP 401): Unauthorized (#401) — sign in to Hooktheory again in Settings → Accounts",
    );
  });

  it("rejects a chord id holding a comma before any request", async () => {
    const calls = stubFetch({
      token: SIGNED_IN,
      hooktheory: () => jsonReply([]),
    });
    expect(await rejection(getTrendNodes(["1,4"]))).toBeInstanceOf(Error);
    expect(await rejection(getTrendSongs([], 1))).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
  });
});
