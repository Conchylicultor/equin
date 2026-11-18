// The collector is the ONE place a server rejection reaches the user and the
// developer: each sink body becomes exactly one error toast (the edit is gone,
// and why — raised by `RejectionToasts` through `useToast`, so it is recorded
// in the notification history) and one `optimistic-rejection` report. A
// detached drain leaves the sink inert.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { optimisticRejectionSink } from "@plugins/network/plugins/live/web";
import { report } from "@plugins/reports/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { collectOptimisticRejection } from "../internal/optimistic-rejection-collector";
import { RejectionToasts } from "../components/rejection-toasts";

const toastMock = vi.hoisted(() => vi.fn());

vi.mock("@plugins/reports/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  report: vi.fn(async () => null),
}));
vi.mock("@plugins/shell/plugins/notifications/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useToast: () => toastMock,
}));

const reportMock = vi.mocked(report);
const collector = drain(optimisticRejectionSink, collectOptimisticRejection);
let detach: (() => void) | null = null;

const body = {
  resourceKey: "page.blocks",
  params: { pageId: "page-1" },
  label: "Page",
  status: 400,
  message: "destination is outside the page",
  opSummary: "bulkMove",
  agentWriteRefused: false,
};

afterEach(() => {
  cleanup();
  detach?.();
  detach = null;
  reportMock.mockClear();
  toastMock.mockClear();
});

describe("collectOptimisticRejection", () => {
  it("turns one rejection into one error toast and one report", () => {
    render(<RejectionToasts />);
    detach = collector.attach();
    optimisticRejectionSink.emit(body);

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0]![0]).toEqual({
      type: "optimistic-rejection",
      variant: "error",
      category: "other",
      title: "Couldn't save page edit",
      description: "destination is outside the page",
    });

    expect(reportMock).toHaveBeenCalledTimes(1);
    const sent = reportMock.mock.calls[0]![0];
    expect(sent.kind).toBe("optimistic-rejection");
    expect(sent.source).toBe("client-optimistic-rejection");
    expect(sent.message).toBe(
      "Write rejected with HTTP 400: page.blocks/Page (bulkMove) — destination is outside the page",
    );
    const { agentWriteRefused: _refused, ...payload } = body;
    expect(sent.data).toEqual(payload);
  });

  it("an agent-write refusal on main is toasted but files no report", () => {
    render(<RejectionToasts />);
    detach = collector.attach();
    optimisticRejectionSink.emit({
      ...body,
      status: 403,
      agentWriteRefused: true,
    });
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(reportMock).not.toHaveBeenCalled();
  });

  it("titles an unlabelled surface generically", () => {
    render(<RejectionToasts />);
    detach = collector.attach();
    optimisticRejectionSink.emit({ ...body, label: null, opSummary: null });
    expect(toastMock.mock.calls[0]![0]).toMatchObject({
      title: "Couldn't save edit",
    });
    expect(reportMock.mock.calls[0]![0].message).toBe(
      "Write rejected with HTTP 400: page.blocks — destination is outside the page",
    );
  });

  it("a rejection before the toaster mounts is held, then toasted", () => {
    detach = collector.attach();
    optimisticRejectionSink.emit(body);
    expect(toastMock).not.toHaveBeenCalled();
    render(<RejectionToasts />);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("unregisters on detach so a later emit reaches nothing", () => {
    render(<RejectionToasts />);
    collector.attach()();
    optimisticRejectionSink.emit(body);
    expect(toastMock).not.toHaveBeenCalled();
    expect(reportMock).not.toHaveBeenCalled();
  });
});
