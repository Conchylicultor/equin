/**
 * Debug → Notifications (the bell's "View all"), over a stubbed DataView —
 * how rows draw, page and group is the primitive's tested behaviour; this pins
 * what the pane hands it:
 *
 * - the field schema resolves against the live source exactly as the DataView
 *   resolves it at mount (every field binds its column, `createdAt` is the one
 *   sort, `read` is a column a `GROUP BY` counts — so the authored group-by
 *   lowers to server sections);
 * - the authored config groups on `read` (the bool `value` grouping) newest
 *   first, against fields that exist;
 * - `type` / `variant` are facets, so they declare no options of their own;
 * - a row activates only when it carries an in-app link; the item actions
 *   dismiss through the endpoint and open only a linked row.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FilterOperatorSet } from "@plugins/primitives/plugins/data-view/web";
import { resolveLiveFields } from "@plugins/primitives/plugins/data-view/web/testing";
import { boolGroupings } from "@plugins/fields/plugins/bool/plugins/data-view-group/core";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { notificationsRoute } from "../../core";
import type { Notification } from "../../shared/schema";

/** An in-app link, built from a route as every `linkTo` is. */
const IN_APP_LINK = notificationsRoute.link(debugApp, {});

const stub = vi.hoisted(() => ({
  /** The props the stubbed DataView last rendered with. */
  props: undefined as Record<string, unknown> | undefined,
  /** Every `mutate` call, by endpoint route. */
  mutations: [] as { route: string; vars: unknown }[],
}));

vi.mock(
  "@plugins/primitives/plugins/data-view/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    DataView: (props: Record<string, unknown>) => {
      stub.props = props;
      return null;
    },
  }),
);

vi.mock("@plugins/infra/plugins/endpoints/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEndpointMutation: (endpoint: { route: string }) => ({
    isPending: false,
    mutate: (vars: unknown) => {
      stub.mutations.push({ route: endpoint.route, vars });
    },
  }),
}));

vi.mock("@plugins/apps-core/plugins/tabs/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  appLink: (url: string) => ({ open: () => {}, href: () => url }),
}));

import {
  DismissNotificationAction,
  NotificationsView,
  OpenNotificationAction,
  fields,
  notificationsSource,
} from "../components/notifications-view";

afterEach(cleanup);
beforeEach(() => {
  stub.props = undefined;
  stub.mutations = [];
});

const note = (over: Partial<Notification> = {}): Notification => ({
  id: "notif-1",
  type: "build",
  title: "Build failed",
  description: "",
  variant: "error",
  dismissed: false,
  read: false,
  muted: false,
  linkTo: null,
  metadata: null,
  count: 1,
  lastSeenAt: new Date("2026-10-13T10:00:00Z"),
  createdAt: new Date("2026-10-13T10:00:00Z"),
  ...over,
});

/** Operator sets reduced to what field resolution reads: each type's domain. */
const DOMAINS: Record<string, FilterOperatorSet["domain"]> = {
  text: "text",
  enum: "text",
  bool: "boolean",
  date: "instant",
};
const resolveOperatorSet = (type: string): FilterOperatorSet | undefined =>
  DOMAINS[type] === undefined
    ? undefined
    : { match: type, domain: DOMAINS[type]!, operators: [] };

const plan = () =>
  resolveLiveFields<Notification>(
    fields,
    notificationsSource,
    resolveOperatorSet,
    "shell.notifications",
  );

describe("the field schema over the notifications source", () => {
  it("binds every field to its column; createdAt is the one sort", () => {
    const p = plan();
    expect([...p.columnOf.keys()].sort()).toEqual(
      ["createdAt", "muted", "read", "title", "type", "variant"].sort(),
    );
    expect(p.sortFields.map((f) => f.id)).toEqual(["createdAt"]);
    expect(p.filterFields.map((f) => f.id).sort()).toEqual(
      ["muted", "read", "title", "type", "variant"].sort(),
    );
  });

  it("`read` groups as server sections: a GROUP BY column under a one-bucket-per-value grouping", () => {
    expect(plan().groupColumns.has("read")).toBe(true);
    const value = boolGroupings.find((g) => g.id === "value");
    expect(value?.oneBucketPerValue).toBe(true);
  });

  it("type / variant are facets, so their fields declare no options", () => {
    expect([...notificationsSource.facets].sort()).toEqual(["type", "variant"]);
    expect(notificationsSource.searchable).toEqual(["title"]);
    for (const id of ["type", "variant"]) {
      const f = fields.find((x) => x.id === id)!;
      expect(f.options).toBeUndefined();
      expect(f.filterable).toBe(true);
    }
  });
});

describe("the authored view (config/shell/notifications)", () => {
  const CONFIG_PATH = join(
    __dirname,
    // __tests__ → web → notifications → plugins → shell → plugins → repo root
    "../../../../../..",
    "config/shell/notifications/shell.notifications.jsonc",
  );

  it("groups on `read` by value, newest first, over fields that exist", () => {
    const errors: ParseError[] = [];
    const doc = parseJsonc(readFileSync(CONFIG_PATH, "utf8"), errors) as {
      views: {
        view: {
          type: string;
          groupBy?: { fieldId: string; groupingId: string };
          sort?: { fieldId: string; direction: string }[];
        };
      }[];
    };
    expect(errors).toEqual([]);
    expect(doc.views).toHaveLength(1);
    const { view } = doc.views[0]!;
    expect(view.type).toBe("list");
    expect(view.groupBy).toEqual({ fieldId: "read", groupingId: "value" });
    expect(view.sort).toEqual([{ fieldId: "createdAt", direction: "desc" }]);
    const ids = new Set(fields.map((f) => f.id));
    expect(ids.has(view.groupBy!.fieldId)).toBe(true);
    expect(view.sort!.every((s) => ids.has(s.fieldId))).toBe(true);
  });
});

describe("<NotificationsView>", () => {
  const activationOf = (n: Notification): Activation | undefined =>
    (stub.props!.rowActivation as (r: Notification) => Activation | undefined)(
      n,
    );

  it("hands the DataView the live source, its storage key and the item actions", () => {
    render(<NotificationsView />);
    expect(stub.props!.source).toBe(notificationsSource);
    expect(stub.props!.storageKey).toBe("shell.notifications");
    expect(stub.props!.views).toEqual(["list"]);
    expect(stub.props!.itemActions).toBeDefined();
  });

  it("a row activates only through an in-app link", () => {
    render(<NotificationsView />);
    expect(activationOf(note())).toBeUndefined();
    expect(activationOf(note({ linkTo: "https://example.com" }))).toBe(
      undefined,
    );
    const act = activationOf(note({ linkTo: IN_APP_LINK }));
    expect(act !== undefined && typeof act === "object" && act.href()).toBe(
      IN_APP_LINK,
    );
  });
});

describe("item actions", () => {
  it("Dismiss posts the row's dismiss", () => {
    render(
      <DismissNotificationAction
        row={note({ id: "notif-7" })}
        hasChildren={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(stub.mutations).toEqual([
      {
        route: "POST /api/notifications/:id/dismiss",
        vars: { params: { id: "notif-7" } },
      },
    ]);
  });

  it("Open renders only for a row with an in-app link", () => {
    const { container } = render(
      <OpenNotificationAction row={note()} hasChildren={false} />,
    );
    expect(container.innerHTML).toBe("");
    cleanup();
    render(
      <OpenNotificationAction
        row={note({ linkTo: IN_APP_LINK })}
        hasChildren={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });
});
