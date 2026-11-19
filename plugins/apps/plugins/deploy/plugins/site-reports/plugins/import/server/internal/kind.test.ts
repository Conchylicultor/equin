import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { clearCollectedContributions } from "@plugins/framework/plugins/server-core/core/testing";
import { ReportKind } from "@plugins/reports/server";
import type { ReportCategory } from "@plugins/reports/core";
import {
  WEBSITE_VISITOR_ERROR_KIND,
  WEBSITE_VISITOR_SLOWNESS_KIND,
} from "../../core";
import {
  importedKindOf,
  websiteVisitorErrorKind,
  websiteVisitorSlownessKind,
} from "./kind";

// A site kind as the site's registry (deployed from this code) declares it.
const siteKind = (kind: string, category: ReportCategory) =>
  ReportKind({
    kind,
    schema: z.unknown(),
    fingerprint: () => kind,
    meta: { tag: `[${kind}]`, notif: kind, variant: "error", category },
    renderTask: () => ({ title: kind, description: kind }),
  });

describe("importedKindOf", () => {
  collectContributions([
    {
      id: "test",
      contributions: [
        siteKind("crash", "error"),
        siteKind("slow-page-load", "slow-op"),
        websiteVisitorErrorKind,
        websiteVisitorSlownessKind,
      ],
    },
  ]);
  afterAll(() => clearCollectedContributions());

  test("the category the site stamped decides, registered here or not", () => {
    expect(importedKindOf({ kind: "site-only", category: "slow-op" })).toBe(
      WEBSITE_VISITOR_SLOWNESS_KIND,
    );
    expect(importedKindOf({ kind: "slow-page-load", category: "error" })).toBe(
      WEBSITE_VISITOR_ERROR_KIND,
    );
  });

  test("a row with no stamped category falls back to this computer's registry", () => {
    expect(importedKindOf({ kind: "crash", category: null })).toBe(
      WEBSITE_VISITOR_ERROR_KIND,
    );
    expect(importedKindOf({ kind: "slow-page-load", category: null })).toBe(
      WEBSITE_VISITOR_SLOWNESS_KIND,
    );
  });

  test("a kind neither the row nor this computer categorises is an error", () => {
    expect(importedKindOf({ kind: "from-a-newer-site", category: null })).toBe(
      WEBSITE_VISITOR_ERROR_KIND,
    );
  });

  test("the two imported kinds sit in the error and slow-op categories", () => {
    const meta = (k: string) =>
      ReportKind.getContributions().find((c) => c.kind === k)?.meta;
    expect(meta(WEBSITE_VISITOR_ERROR_KIND)?.category).toBe("error");
    expect(meta(WEBSITE_VISITOR_SLOWNESS_KIND)?.category).toBe("slow-op");
    expect(meta(WEBSITE_VISITOR_SLOWNESS_KIND)?.variant).toBe("warning");
  });
});
