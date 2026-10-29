/**
 * The bell's badge reads the `notifications.unread` VALUE (a whole-table
 * count), not the loaded window: pending paints a neutral bell, settled paints
 * the count (label exact, badge capped at "9+") in red only while an error is
 * among them — the counts of the reader's audience (a user's leaves out what
 * is declared for developers). Data is driven with `client.setQueryData` on
 * the exact tuples.
 *
 * Closing the popover after it opened with unread items marks all read — but
 * leaving through the panel's "View all" (to Debug → Notifications) does not:
 * it closes through `onClose`, never the popover's own `onOpenChange`.
 *
 * The bell mirrors the toasts: an arriving notification is toasted as the
 * same `NotificationView` its popover row draws (4s, an error until handled),
 * the chips are the user's categories, and an action kind no plugin
 * registered throws rather than drawing nothing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

const spy = vi.hoisted(() => ({
  /** Every app link opened. */
  opened: [] as string[],
  /** The reader's audience. A developer's bell reads the default window. */
  audience: "developer" as "user" | "developer",
  /** Every toast shown. */
  toasts: [] as {
    render: (toast: { dismiss: () => void }) => unknown;
    duration: number;
  }[],
}));

vi.mock("@plugins/shell/plugins/toast/web", () => ({
  showToast: (args: {
    render: (toast: { dismiss: () => void }) => unknown;
    duration: number;
  }) => {
    spy.toasts.push(args);
  },
}));

vi.mock("@plugins/audience/web", () => ({
  useAudience: () => ({
    status: "ready",
    data: spy.audience,
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock("@plugins/apps-core/plugins/tabs/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAppLink: () => (url: string) => ({
    open: () => {
      spy.opened.push(url);
    },
    href: () => url,
  }),
}));

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import {
  createLiveStateHarness,
  type LiveStateHarness,
} from "@plugins/primitives/plugins/live-state/web/testing";
import {
  fakeFetchEndpoint,
  type FakeFetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web/testing";
import type { ReactElement } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { notificationIdKind, notificationsRoute } from "../../core";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import {
  notifications,
  notificationsUnread,
  type Notification,
} from "../../shared/resources";
import { Notifications, openAction, reloadAction } from "../internal/actions";
import {
  NotificationView,
  raisedByTab,
  recurrenceLabel,
} from "../components/notification-view";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { TabOrigin } from "@plugins/apps-core/plugins/tab-origin/web";
import { audienceScope } from "../../shared/audience-scope";
import { BellButton } from "../components/bell-button";

afterEach(() => {
  cleanup();
  spy.opened = [];
  spy.audience = "developer";
  spy.toasts = [];
});

/** The fetcher every harness's transport hands the bell (its mark-all-read). */
let fake: FakeFetchEndpoint;
/** Every endpoint route the bell called. */
const fetched = () => fake.calls.map((c) => c.route);

/** A harness whose endpoint clients answer from a fresh `fake`. */
function harness(): LiveStateHarness {
  fake = fakeFetchEndpoint();
  return createLiveStateHarness({ transport: fake.transport });
}

/** The plugin's own action kinds, as the registry a page has. */
const actionsPlugin = {
  id: "notifications-test",
  description: "the notifications action kinds",
  contributions: [
    Notifications.Action(openAction),
    Notifications.Action(reloadAction),
    // A kind that draws its own control (build-fix's Fix is one).
    Notifications.Action({
      kind: "own-control",
      label: "Fix",
      Control: ({ payload, label }) => (
        <button type="button">{`${label} ${String(payload.runId)}`}</button>
      ),
    }),
  ],
} as unknown as LoadedPlugin;

function withActions(node: ReactElement) {
  return <PluginProvider plugins={[actionsPlugin]}>{node}</PluginProvider>;
}

function mount(live: LiveStateHarness) {
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  return render(
    withActions(
      <live.Wrapper>
        <BellButton />
      </live.Wrapper>,
    ),
  );
}

const note = (over: Partial<Notification> = {}): Notification => ({
  id: notificationIdKind.key("notif-arrived"),
  type: "build",
  title: "equin was updated",
  description: "",
  variant: "info",
  dismissed: false,
  read: false,
  muted: false,
  audience: "user",
  category: "updates",
  linkTo: null,
  subjectId: null,
  subjectName: "Fix login bug",
  detail: null,
  action: { kind: "open", payload: { to: "/agents" } },
  icon: null,
  metadata: null,
  count: 1,
  $columns: {},
  lastSeenAt: new Date("2026-10-25T10:00:00Z"),
  createdAt: new Date("2026-10-25T10:00:00Z"),
  ...over,
});

const windowKey = () => {
  if (!notifications.window.defaultParams) {
    throw new Error("notifications window has no default tuple");
  }
  return queryKeyFor(notifications.key, notifications.window.defaultParams);
};
const unreadKey = () => queryKeyFor(notificationsUnread.key, {});

type Counts = { errors: number; warnings: number };

function settled(
  developer: Counts,
  user: Counts = developer,
): LiveStateHarness {
  const live = harness();
  live.queryClient.setQueryData(windowKey(), []);
  live.queryClient.setQueryData(unreadKey(), { user, developer });
  return live;
}

describe("BellButton — unread badge", () => {
  it("paints a neutral bell (no count) while the unread value is pending", () => {
    const live = harness();
    const client = live.queryClient;
    client.setQueryData(windowKey(), []);
    mount(live);
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
    expect(screen.queryByText(/^\d|9\+/)).toBeNull();
  });

  it("labels the exact count, caps the badge at 9+, and is red with an error", () => {
    mount(settled({ errors: 3, warnings: 250 }));
    expect(
      screen.getByRole("button", { name: "Notifications, 253 unread" }),
    ).toBeTruthy();
    const badge = screen.getByText("9+");
    // The solid fill (deep red, light figures in the chrome), not the bright
    // `destructive` the chrome keeps for text.
    expect(badge.className).toContain("bg-destructive-solid");
    expect(badge.className).toContain("text-destructive-solid-foreground");
  });

  it("is amber (the solid warning fill) when only warnings are unread", () => {
    mount(settled({ errors: 0, warnings: 2 }));
    expect(
      screen.getByRole("button", { name: "Notifications, 2 unread" }),
    ).toBeTruthy();
    expect(screen.getByText("2").className).toContain("bg-warning-solid");
  });

  it("counts only what reaches a user outside Developer mode", () => {
    spy.audience = "user";
    const live = harness();
    // A user's bell reads its audience-scoped window, not the default one.
    live.queryClient.setQueryData(
      queryKeyFor(
        notifications.key,
        notifications.window.window.encode({ where: audienceScope("user") }),
      ),
      [],
    );
    live.queryClient.setQueryData(unreadKey(), {
      user: { errors: 0, warnings: 2 },
      developer: { errors: 40, warnings: 700 },
    });
    mount(live);
    expect(
      screen.getByRole("button", { name: "Notifications, 2 unread" }),
    ).toBeTruthy();
    expect(screen.getByText("2").className).toContain("bg-warning-solid");
  });

  it("shows no badge at zero", () => {
    mount(settled({ errors: 0, warnings: 0 }));
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });
});

describe("BellButton — leaving the popover", () => {
  const MARK_ALL_READ = "POST /api/notifications/mark-all-read";

  async function openPopover() {
    mount(settled({ errors: 1, warnings: 0 }));
    fireEvent.click(
      screen.getByRole("button", { name: "Notifications, 1 unread" }),
    );
    // The panel mounts only while open.
    return waitFor(() => screen.getByText("View all"));
  }

  it("View all opens Debug → Notifications and closes without marking read", async () => {
    fireEvent.click(await openPopover());
    expect(spy.opened).toEqual(["/debug/notifications"]);
    await waitFor(() => {
      expect(screen.queryByText("View all")).toBeNull();
    });
    expect(fetched()).not.toContain(MARK_ALL_READ);
  });

  it("dismissing the popover itself (Escape) marks all read", async () => {
    await openPopover();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() => {
      expect(fetched()).toContain(MARK_ALL_READ);
    });
  });
});

describe("BellButton — toasts mirror the bell", () => {
  async function arrive(n: Notification) {
    const live = settled({ errors: 0, warnings: 0 });
    mount(live);
    await waitFor(() => screen.getByRole("button", { name: "Notifications" }));
    live.queryClient.setQueryData(windowKey(), [n]);
    await waitFor(() => {
      expect(spy.toasts).toHaveLength(1);
    });
    return spy.toasts[0]!;
  }

  it("an arrival is toasted as the NotificationView its row draws, for 4s", async () => {
    const toast = await arrive(note());
    expect(toast.duration).toBe(4000);
    cleanup();
    let dismissed = 0;
    const { container } = render(
      withActions(
        toast.render({
          dismiss: () => {
            dismissed++;
          },
        }) as ReactElement,
      ),
    );
    const view = container.querySelector("[data-notification-view]");
    expect(view?.textContent).toContain("equin was updated");
    expect(view?.textContent).toContain("Fix login bug");
    // The toast's body is no link: its only control is the action button
    // (a click elsewhere is the toast host's click-to-dismiss, never a
    // navigation).
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Open",
    ]);
    fireEvent.click(screen.getByText("equin was updated"));
    expect(spy.opened).toEqual([]);
    // The action, resolved through the registry; running it navigates and
    // dismisses the toast.
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(spy.opened).toEqual(["/agents"]);
    expect(dismissed).toBe(1);
  });

  it("a toast with no action offers a quiet Dismiss in its place", async () => {
    const toast = await arrive(note({ action: null }));
    cleanup();
    let dismissed = 0;
    render(
      withActions(
        toast.render({
          dismiss: () => {
            dismissed++;
          },
        }) as ReactElement,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissed).toBe(1);
  });

  it("an error stays until dismissed or acted on", async () => {
    const toast = await arrive(note({ variant: "error" }));
    expect(toast.duration).toBe(Infinity);
  });

  it("a row from before actions opens its linkTo", () => {
    const linkTo = notificationsRoute.link(debugApp, {});
    render(
      withActions(
        <NotificationView surface="bell" n={note({ action: null, linkTo })} />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(spy.opened).toEqual([linkTo]);
  });

  it("an action kind no plugin registered throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        withActions(
          <NotificationView
            surface="bell"
            n={note({ action: { kind: "nope", payload: {} } })}
          />,
        ),
      ),
    ).toThrow(/"nope" is not registered/);
  });
});

describe("BellButton — opening a row", () => {
  /** The popover open over one row whose action opens `/agents`. */
  async function openWith(n: Notification) {
    const live = settled({ errors: 0, warnings: 0 });
    live.queryClient.setQueryData(windowKey(), [n]);
    mount(live);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    const list = await waitFor(() => screen.getByTestId("notification-list"));
    return list;
  }
  /** The row's own control: the button the headline is drawn in. */
  const rowControl = (list: HTMLElement) => {
    const control = list.querySelector<HTMLElement>(
      "[data-notification-view] > button",
    );
    if (control === null) throw new Error("the row has no control");
    return control;
  };

  it("clicking the row opens its action's target and closes the popover", async () => {
    const list = await openWith(note());
    fireEvent.click(rowControl(list));
    expect(spy.opened).toEqual(["/agents"]);
    await waitFor(() => {
      expect(screen.queryByTestId("notification-list")).toBeNull();
    });
  });

  it("a row from before actions opens its legacy linkTo", async () => {
    const linkTo = notificationsRoute.link(debugApp, {});
    const list = await openWith(note({ action: null, linkTo }));
    fireEvent.click(rowControl(list));
    expect(spy.opened).toEqual([linkTo]);
  });

  it("the action button opens once — its click does not reach the row", async () => {
    await openWith(note());
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(spy.opened).toEqual(["/agents"]);
    await waitFor(() => {
      expect(screen.queryByTestId("notification-list")).toBeNull();
    });
  });

  it("the row is a real button (focusable; Enter / Space activate it natively), beside — never around — its action", async () => {
    const list = await openWith(note());
    const control = rowControl(list);
    expect(control.tagName).toBe("BUTTON");
    control.focus();
    expect(document.activeElement).toBe(control);
    // The action is the control's sibling: the two click targets never nest.
    const open = screen.getByRole("button", { name: "Open" });
    expect(control.contains(open)).toBe(false);
  });

  it("a row whose action only runs (Reload) is not itself clickable", async () => {
    const list = await openWith(
      note({ action: { kind: "reload", payload: {} } }),
    );
    expect(list.querySelector("[data-notification-view] > button")).toBeNull();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });
});

describe("BellButton — chips by category", () => {
  const groupsKey = (groupBy: "category" | "variant") =>
    queryKeyFor(
      `${notifications.key}:groups`,
      notifications.groups.groups.encode({
        groupBy,
        limit: notifications.groups.groups.defaultLimit,
      }),
    );

  it("offers the user's categories, never the raw types", async () => {
    const live = settled({ errors: 0, warnings: 0 });
    live.queryClient.setQueryData(windowKey(), [note()]);
    live.queryClient.setQueryData(groupsKey("category"), [
      { value: "updates", count: 1 },
    ]);
    live.queryClient.setQueryData(groupsKey("variant"), [
      { value: "info", count: 1 },
    ]);
    mount(live);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await waitFor(() => {
      const chips = screen.getByTestId("notification-chips");
      expect(
        [...chips.querySelectorAll("button")].map((b) => b.textContent),
      ).toEqual([
        "All",
        "Errors 0",
        "Conversations 0",
        "Updates 1",
        "Automations 0",
      ]);
    });
    // The row is the same view the toast draws.
    expect(screen.getByTestId("notification-list").textContent).toContain(
      "equin was updated",
    );
  });
});

describe("NotificationView — what a notification says", () => {
  it("draws the producer's own glyph", () => {
    const { container } = render(
      withActions(
        <NotificationView surface="bell" n={note({ icon: symbol("forum") })} />,
      ),
    );
    expect(container.querySelector("use")?.getAttribute("href")).toMatch(
      /forum$/,
    );
  });

  it("names its subject on a chip", () => {
    render(
      withActions(
        <NotificationView
          surface="bell"
          n={note({ subjectId: "conv-1793145729-ab12cd" })}
        />,
      ),
    );
    expect(screen.getByText("Fix login bug")).toBeTruthy();
  });

  it("a developer row: description, then the count and the kind; never monospace", () => {
    const { container } = render(
      withActions(
        <NotificationView
          surface="bell"
          n={note({
            audience: "developer",
            type: "report",
            title: "Slow operation detected",
            subjectName: null,
            description: "update x took 3119ms (threshold 1000ms)",
            detail: "fingerprint abc",
            count: 120,
            action: null,
          })}
        />,
      ),
    );
    expect(
      screen.getByText("update x took 3119ms (threshold 1000ms)"),
    ).toBeTruthy();
    expect(screen.getByText("×99+")).toBeTruthy();
    expect(screen.getByText("· report")).toBeTruthy();
    expect(container.querySelector(".text-code, .font-mono")).toBeNull();
  });

  it("a user row shows no kind, and nothing when there is no meta", () => {
    render(withActions(<NotificationView surface="bell" n={note()} />));
    expect(screen.queryByText(/build/)).toBeNull();
  });

  it("an action kind may draw its own control", () => {
    render(
      withActions(
        <NotificationView
          surface="bell"
          n={note({
            action: { kind: "own-control", payload: { runId: "b1" } },
          })}
        />,
      ),
    );
    expect(screen.getByRole("button", { name: "Fix b1" })).toBeTruthy();
  });

  it("recurrence: nothing once, ×N after, capped at 99+", () => {
    expect(recurrenceLabel(1)).toBeNull();
    expect(recurrenceLabel(12)).toBe("×12");
    expect(recurrenceLabel(100)).toBe("×99+");
  });

  it("which tab: only for a failure a tab raised", () => {
    const other = {
      kind: "other" as const,
      appName: "Places",
      presence: "open" as const,
    };
    const by = (origin: TabOrigin, variant: Notification["variant"]) =>
      raisedByTab({ variant }, origin, "bell");
    expect(by({ kind: "this" }, "error")).toBe("this tab");
    expect(by(other, "warning")).toBe("another Places tab");
    expect(by({ ...other, presence: "closed" }, "error")).toBe(
      "closed Places tab",
    );
    expect(by({ ...other, appName: null, presence: "loading" }, "error")).toBe(
      "another tab",
    );
    expect(by({ kind: "this" }, "success")).toBeNull();
    expect(by({ kind: "none" }, "error")).toBeNull();
  });

  it("which tab: a toast names only another tab", () => {
    const by = (origin: TabOrigin) =>
      raisedByTab({ variant: "error" }, origin, "toast");
    expect(by({ kind: "this" })).toBeNull();
    expect(by({ kind: "other", appName: "Menu bar", presence: "closed" })).toBe(
      "closed Menu bar tab",
    );
  });
});
