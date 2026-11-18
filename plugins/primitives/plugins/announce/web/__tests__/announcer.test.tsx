/**
 * The announcer's DOM contract: what `announce()` writes is what the live
 * regions hold, on the channel the caller asked for — and, the case the whole
 * design exists for, an identical message announced twice in a row produces two
 * *different* rendered strings, so assistive tech sees a change both times.
 *
 * Every test uses its own message text: the store is page-global by design (one
 * host, one speech queue) and therefore keeps its contents across tests, exactly
 * as it does across surfaces in the app. Distinct strings keep each case
 * independent of what ran before it, without the module needing a `reset` — the
 * same reasoning as the toast ledger's "no lifecycle hook clears it".
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { AnnouncerHost } from "../components/announcer-host";
import { announce } from "../index";

/** Live-region text as the DOM holds it — trailing space and all. */
function politeText(): string {
  return screen.getByRole("status").textContent;
}

function assertiveText(): string {
  return screen.getByRole("alert").textContent;
}

/** External-store writes are not React events; `act` flushes the re-render. */
function say(message: string, opts?: { assertive?: boolean }): void {
  act(() => {
    announce(message, opts);
  });
}

afterEach(cleanup);

describe("the announcer host renders what announce() writes", () => {
  it("mounts both regions empty, so a later write is a change AT can observe", () => {
    // A live region has to exist BEFORE its text changes. If the region and its
    // first message arrived in the same commit there would be no change to
    // announce, which is the single most common reason an aria-live never
    // speaks. The host is at Core.Root precisely so this holds.
    render(<AnnouncerHost />);

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("puts a polite announcement in the status region", () => {
    render(<AnnouncerHost />);

    say("Heading 2: Container frames, block 3 of 9, selected");

    expect(politeText()).toBe(
      "Heading 2: Container frames, block 3 of 9, selected",
    );
  });

  it("puts an assertive announcement in the alert region, leaving polite alone", () => {
    render(<AnnouncerHost />);

    say("Nine blocks selected");
    say("Delete failed", { assertive: true });

    expect(assertiveText()).toBe("Delete failed");
    // The two channels are independent: an interruption must not wipe the
    // queued polite text, or the last polite message would be re-announced as
    // an empty string.
    expect(politeText()).toBe("Nine blocks selected");
  });

  it("renders two DIFFERENT strings for two identical consecutive announcements", () => {
    // THE case this primitive exists for. Selecting the same block twice
    // produces the same sentence, and an unchanged live region is silent —
    // exactly when the user asked for confirmation. The repeat lands as the
    // same text plus a trailing space (unspoken), so the DOM changes without a
    // timer clearing anything.
    render(<AnnouncerHost />);

    say("Selection cleared");
    const first = politeText();

    say("Selection cleared");
    const second = politeText();

    expect(first).toBe("Selection cleared");
    expect(second).not.toBe(first);
    expect(second.trim()).toBe(first);

    // And it toggles back rather than growing a space per repeat.
    say("Selection cleared");
    expect(politeText()).toBe(first);
  });

  it("is a silent no-op when no host is mounted", () => {
    // Callable from anywhere, with no obligation on the caller to know whether
    // the app shell is up.
    expect(() => announce("nobody is listening")).not.toThrow();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ignores an empty message", () => {
    render(<AnnouncerHost />);

    say("All 9 blocks selected");
    say("   ");

    expect(politeText()).toBe("All 9 blocks selected");
  });
});
