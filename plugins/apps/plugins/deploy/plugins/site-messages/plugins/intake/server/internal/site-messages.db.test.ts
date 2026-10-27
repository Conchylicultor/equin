/**
 * Real-Postgres suite for the intake: a message through the classifier, the
 * rate limiter and the notify job, then the spam sweep. Runs the real
 * migration chain on a throwaway database (db-test-fixture).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { sweepExpired } from "@plugins/infra/plugins/retention/server/testing";
import type {
  ResendEmail,
  ResendSendResult,
} from "@plugins/integrations/plugins/resend/server";
import {
  SPAM_RETENTION_DAYS,
  SiteMessageBodySchema,
  siteMessageIdKind,
  type SiteMessageId,
} from "../../core";
import {
  CONFIRM_PER_ADDRESS_CAP,
  confirmSiteMessage,
  type ConfirmDeps,
} from "./confirm";
import { recordSiteMessage, type IntakeContext } from "./intake";
import { listSiteMessages } from "./list";
import { DAILY_EMAIL_CAP, notifySiteMessage, type NotifyDeps } from "./notify";
import { SPAM_ONLY } from "./retention";
import { siteMessages } from "./tables";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const NOW = new Date("2026-10-24T12:00:00Z");

let t: TestDb;
let enqueued: SiteMessageId[];

beforeAll(async () => {
  t = await createTestDb({ prefix: "site_messages_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.delete(siteMessages);
  enqueued = [];
});

function body(over: Record<string, unknown> = {}) {
  // Decode exactly as the route does, so the schema's guards are under test.
  return SiteMessageBodySchema.parse({
    message: "  Hello there  ",
    replyTo: "visitor@example.com",
    honeypot: "",
    elapsedMs: 15_000,
    host: "equin.ai",
    page: "/?utm_source=x",
    ...over,
  });
}

function send(
  over: Record<string, unknown> = {},
  ctx: Partial<IntakeContext> = {},
) {
  return recordSiteMessage(
    t.db,
    body(over),
    { ip: "203.0.113.7", userAgent: CHROME, now: NOW, ...ctx },
    async (id) => {
      enqueued.push(id);
    },
  );
}

/** The error a promise rejects with; a resolve fails the test. */
function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err,
  );
}

async function rows() {
  return t.db.select().from(siteMessages).orderBy(siteMessages.createdAt);
}

describe("intake", () => {
  test("an accepted message is stored trimmed, its notification queued", async () => {
    expect(await send()).toEqual({ kind: "sent" });
    const [row] = await rows();
    expect(row).toMatchObject({
      message: "Hello there",
      replyTo: "visitor@example.com",
      page: "/",
      verdict: "accepted",
      spamReason: null,
      notifyState: "pending",
      confirmState: "pending",
    });
    expect(row!.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.ipHash).not.toContain("203.0.113.7");
    expect(enqueued).toEqual([row!.id]);
  });

  test("spam is stored with its reason, answered sent, never queued", async () => {
    expect(await send({ honeypot: "http://x" })).toEqual({ kind: "sent" });
    expect(await send({ elapsedMs: 500 }, { ip: "203.0.113.8" })).toEqual({
      kind: "sent",
    });
    expect(await send({}, { ip: "203.0.113.9", userAgent: "curl/8" })).toEqual({
      kind: "sent",
    });
    expect(
      (await rows()).map((r) => [
        r.verdict,
        r.spamReason,
        r.notifyState,
        r.confirmState,
      ]),
    ).toEqual([
      ["spam", "honeypot", "skipped", "skipped"],
      ["spam", "too-fast", "skipped", "skipped"],
      ["spam", "bot-user-agent", "skipped", "skipped"],
    ]);
    expect(enqueued).toEqual([]);
  });

  test("a fourth message in ten minutes is refused and not stored", async () => {
    for (const minute of [0, 1, 2]) {
      expect(
        await send({}, { now: new Date(NOW.getTime() + minute * 60_000) }),
      ).toEqual({ kind: "sent" });
    }
    expect(
      await send({}, { now: new Date(NOW.getTime() + 3 * 60_000) }),
    ).toEqual({ kind: "rate-limited", retryAfterS: 7 * 60 });
    expect(await rows()).toHaveLength(3);
    // Another visitor is not affected.
    expect(await send({}, { ip: "198.51.100.1" })).toEqual({ kind: "sent" });
  });

  test("the list is newest first, filterable by verdict, bounded", async () => {
    await send({}, { now: NOW });
    await send({ honeypot: "x" }, { now: new Date(NOW.getTime() + 1000) });
    const all = await listSiteMessages(t.db, { limit: 1 });
    expect(all.messages.map((m) => m.verdict)).toEqual(["spam"]);
    expect(all.hasMore).toBe(true);
    const accepted = await listSiteMessages(t.db, {
      verdict: "accepted",
      limit: 10,
    });
    expect(accepted.messages).toHaveLength(1);
    expect(accepted.hasMore).toBe(false);
    expect(accepted.messages[0]!.createdAt).toBe(NOW.toISOString());
  });
});

describe("notify", () => {
  function deps(over: Partial<NotifyDeps> = {}): NotifyDeps & {
    sent: ResendEmail[];
  } {
    const sent: ResendEmail[] = [];
    return {
      apiKey: { kind: "set", value: "re_test" },
      to: "hello@equin.ai",
      send: async (_key, email): Promise<ResendSendResult> => {
        sent.push(email);
        return { ok: true, id: `email-${sent.length}` };
      },
      attempt: 1,
      maxAttempts: 5,
      now: NOW,
      sent,
      ...over,
    };
  }

  async function accepted(): Promise<SiteMessageId> {
    await send({}, { ip: `192.0.2.${enqueued.length + 1}` });
    return enqueued.at(-1)!;
  }

  test("without a key, the message is not-configured and nothing throws", async () => {
    const id = await accepted();
    const d = deps({ apiKey: { kind: "unset" } });
    expect(await notifySiteMessage(t.db, id, d)).toEqual({
      kind: "not-configured",
    });
    expect(d.sent).toEqual([]);
    const [row] = await t.db
      .select()
      .from(siteMessages)
      .where(eq(siteMessages.id, id));
    expect(row!.notifyState).toBe("not-configured");
  });

  test("with a key, it emails the site's address, reply-to the visitor", async () => {
    const id = await accepted();
    const d = deps();
    const outcome = await notifySiteMessage(t.db, id, d);
    expect(outcome).toEqual({ kind: "sent", providerId: "email-1", held: 0 });
    expect(d.sent[0]).toMatchObject({
      from: "equin <noreply@equin.ai>",
      to: "hello@equin.ai",
      replyTo: "visitor@example.com",
      subject: "Website message from visitor@example.com",
    });
    expect(d.sent[0]!.text).toContain("Hello there");
    expect(d.sent[0]!.text).toContain("https://equin.ai/");
    const [row] = await t.db
      .select()
      .from(siteMessages)
      .where(eq(siteMessages.id, id));
    expect(row).toMatchObject({ notifyState: "sent", notifyError: null });
    // Settled: a second run does nothing.
    expect(await notifySiteMessage(t.db, id, d)).toEqual({
      kind: "nothing-to-do",
    });
  });

  test("a refused send records the error and throws; the last attempt records failed", async () => {
    const id = await accepted();
    const refusing = deps({
      send: async () => ({
        ok: false,
        status: 403,
        error: "domain not verified",
      }),
    });
    expect(
      String(await rejection(notifySiteMessage(t.db, id, refusing))),
    ).toMatch(/domain not verified/);
    let [row] = await t.db
      .select()
      .from(siteMessages)
      .where(eq(siteMessages.id, id));
    expect(row).toMatchObject({
      notifyState: "pending",
      notifyError: "Resend answered 403: domain not verified",
    });
    expect(
      await rejection(notifySiteMessage(t.db, id, { ...refusing, attempt: 5 })),
    ).toBeInstanceOf(Error);
    [row] = await t.db
      .select()
      .from(siteMessages)
      .where(eq(siteMessages.id, id));
    expect(row!.notifyState).toBe("failed");
  });

  test("past the daily cap a message is held, and the next email counts it", async () => {
    // The cap already spent today.
    await t.db.insert(siteMessages).values(
      Array.from({ length: DAILY_EMAIL_CAP }, (_, i) => ({
        id: siteMessageIdKind.mint(),
        createdAt: new Date(NOW.getTime() - 60 * 60_000),
        message: "earlier",
        replyTo: "a@example.com",
        host: "equin.ai",
        page: "/",
        ipHash: "h",
        verdict: "accepted" as const,
        notifyState: "sent" as const,
        notifiedAt: new Date(NOW.getTime() - (60 - i) * 60_000),
      })),
    );
    const held = await accepted();
    expect(await notifySiteMessage(t.db, held, deps())).toEqual({
      kind: "throttled",
    });
    // A day later the cap has room again; the held one is mentioned.
    const next = await accepted();
    const later = deps({ now: new Date(NOW.getTime() + 25 * 60 * 60_000) });
    const outcome = await notifySiteMessage(t.db, next, later);
    expect(outcome).toMatchObject({ kind: "sent", held: 1 });
    expect(later.sent[0]!.text).toContain(
      "1 more message was held by the daily email cap",
    );
  });
});

describe("confirm", () => {
  function deps(over: Partial<ConfirmDeps> = {}): ConfirmDeps & {
    sent: ResendEmail[];
  } {
    const sent: ResendEmail[] = [];
    return {
      apiKey: { kind: "set", value: "re_test" },
      contact: "hello@equin.ai",
      send: async (_key, email): Promise<ResendSendResult> => {
        sent.push(email);
        return { ok: true, id: `email-${sent.length}` };
      },
      attempt: 1,
      maxAttempts: 5,
      now: NOW,
      sent,
      ...over,
    };
  }

  async function accepted(
    over: Record<string, unknown> = {},
  ): Promise<SiteMessageId> {
    await send(over, { ip: `192.0.2.${enqueued.length + 100}` });
    return enqueued.at(-1)!;
  }

  async function row(id: SiteMessageId) {
    const [r] = await t.db
      .select()
      .from(siteMessages)
      .where(eq(siteMessages.id, id));
    return r!;
  }

  test("emails the visitor a copy, reply-to the site, independently of the notification", async () => {
    const id = await accepted({ message: "Line one\nLine two" });
    const d = deps();
    expect(await confirmSiteMessage(t.db, id, d)).toEqual({
      kind: "sent",
      providerId: "email-1",
    });
    expect(d.sent[0]).toMatchObject({
      from: "equin <noreply@equin.ai>",
      to: "visitor@example.com",
      replyTo: "hello@equin.ai",
      subject: "We received your message",
    });
    expect(d.sent[0]!.text).toContain("> Line one\n> Line two");
    expect(await row(id)).toMatchObject({
      confirmState: "sent",
      confirmError: null,
      // The notification is its own job: untouched.
      notifyState: "pending",
    });
    expect(await confirmSiteMessage(t.db, id, d)).toEqual({
      kind: "nothing-to-do",
    });
  });

  test("without a key, the confirmation is not-configured and nothing throws", async () => {
    const id = await accepted();
    const d = deps({ apiKey: { kind: "unset" } });
    expect(await confirmSiteMessage(t.db, id, d)).toEqual({
      kind: "not-configured",
    });
    expect(d.sent).toEqual([]);
    expect((await row(id)).confirmState).toBe("not-configured");
  });

  test("a refused send records the error and throws; the last attempt records failed", async () => {
    const id = await accepted();
    const refusing = deps({
      send: async () => ({ ok: false, status: 422, error: "bad address" }),
    });
    expect(
      String(await rejection(confirmSiteMessage(t.db, id, refusing))),
    ).toMatch(/bad address/);
    expect(await row(id)).toMatchObject({
      confirmState: "pending",
      confirmError: "Resend answered 422: bad address",
    });
    await rejection(confirmSiteMessage(t.db, id, { ...refusing, attempt: 5 }));
    expect((await row(id)).confirmState).toBe("failed");
  });

  test("one address gets at most the per-address cap a day, whatever its case", async () => {
    const d = deps();
    for (let i = 0; i < CONFIRM_PER_ADDRESS_CAP; i++) {
      const id = await accepted();
      expect((await confirmSiteMessage(t.db, id, d)).kind).toBe("sent");
    }
    const over = await accepted({ replyTo: "Visitor@Example.com" });
    expect(await confirmSiteMessage(t.db, over, d)).toEqual({
      kind: "throttled",
    });
    expect((await row(over)).confirmState).toBe("throttled");
    // Another address is not affected.
    const other = await accepted({ replyTo: "someone@example.com" });
    expect((await confirmSiteMessage(t.db, other, d)).kind).toBe("sent");
  });
});

describe("spam retention", () => {
  test("deletes spam older than the window, never an accepted message", async () => {
    const old = new Date(
      NOW.getTime() - (SPAM_RETENTION_DAYS + 1) * 86_400_000,
    );
    await send({ honeypot: "x" }, { now: old, ip: "192.0.2.50" });
    await send({}, { now: old, ip: "192.0.2.51" });
    await send({ honeypot: "x" }, { now: NOW, ip: "192.0.2.52" });
    await sweepExpired(t.db, {
      table: siteMessages,
      column: siteMessages.createdAt,
      cutoff: new Date(NOW.getTime() - SPAM_RETENTION_DAYS * 86_400_000),
      where: SPAM_ONLY,
    });
    expect(
      (await rows()).map((r) => [r.verdict, r.createdAt.toISOString()]),
    ).toEqual([
      ["accepted", old.toISOString()],
      ["spam", NOW.toISOString()],
    ]);
  });
});
