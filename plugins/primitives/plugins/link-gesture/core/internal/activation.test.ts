import { describe, expect, test } from "bun:test";
import { runActivation, type Activation, type LinkTarget } from "./activation";

const linkTo = (id: string): LinkTarget => ({
  open: () => {},
  href: () => `/${id}`,
});
const voidCall = (): void => {};
const asyncCall = async (): Promise<void> => {};
const voidBinding: () => void = voidCall;

// Type-level guarantees, enforced by tsc (the `type-check` check). The
// function arm is `() => void | undefined` precisely so these fail: were it
// widened back to `() => void`, every `@ts-expect-error` below would go unused
// — itself a tsc error. One declaration per case: an array literal would
// subtype-reduce `() => LinkTarget` into `() => void` and hide the error.

// @ts-expect-error a function returning a LinkTarget drops it on click
export const droppedLink: Activation = () => linkTo("a");

// @ts-expect-error the resolver form (Debug → Logs, 58b9dae65e)
export const droppedInRow: (id: string) => Activation = (id) => () =>
  linkTo(id);

// @ts-expect-error a returned Promise is dropped too
export const droppedPromise: Activation = asyncCall;

export const link: Activation = linkTo("a");
export const voidCallAction: Activation = () => voidCall();
export const boundAction: Activation = voidBinding;
export const blockAction: Activation = () => {
  voidCall();
};
export const voidedPromise: Activation = () => void asyncCall();

describe("runActivation", () => {
  test("runs an action, or a link's plain open", () => {
    const seen: string[] = [];
    runActivation(() => {
      seen.push("action");
    });
    runActivation({ open: () => seen.push("open"), href: () => "/x" });
    expect(seen).toEqual(["action", "open"]);
  });
});
