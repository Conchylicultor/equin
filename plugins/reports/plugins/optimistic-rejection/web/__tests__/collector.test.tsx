// The collector is the ONE place a server rejection reaches the user and the
// developer: each sink body becomes exactly one error toast (the edit is gone,
// and why) and one `optimistic-rejection` report. A collector that is not
// mounted leaves the sink inert.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { optimisticRejectionSink } from "@plugins/primitives/plugins/optimistic-mutation/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { report } from "@plugins/reports/web";
import { OptimisticRejectionCollector } from "../components/optimistic-rejection-collector";

vi.mock("@plugins/reports/web", () => ({
  report: vi.fn(async () => null),
}));
vi.mock("@plugins/shell/plugins/toast/web", () => ({
  showToast: vi.fn(),
}));

const reportMock = vi.mocked(report);
const toastMock = vi.mocked(showToast);

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
  optimisticRejectionSink.register(null);
  reportMock.mockClear();
  toastMock.mockClear();
});

describe("OptimisticRejectionCollector", () => {
  it("turns one rejection into one error toast and one report", () => {
    render(<OptimisticRejectionCollector />);
    optimisticRejectionSink.emit(body);

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0]![0]).toEqual({
      variant: "error",
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
    render(<OptimisticRejectionCollector />);
    optimisticRejectionSink.emit({
      ...body,
      status: 403,
      agentWriteRefused: true,
    });
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(reportMock).not.toHaveBeenCalled();
  });

  it("titles an unlabelled surface generically", () => {
    render(<OptimisticRejectionCollector />);
    optimisticRejectionSink.emit({ ...body, label: null, opSummary: null });
    expect(toastMock.mock.calls[0]![0].title).toBe("Couldn't save edit");
    expect(reportMock.mock.calls[0]![0].message).toBe(
      "Write rejected with HTTP 400: page.blocks — destination is outside the page",
    );
  });

  it("unregisters on unmount so a later emit reaches nothing", () => {
    const { unmount } = render(<OptimisticRejectionCollector />);
    unmount();
    optimisticRejectionSink.emit(body);
    expect(toastMock).not.toHaveBeenCalled();
    expect(reportMock).not.toHaveBeenCalled();
  });
});
