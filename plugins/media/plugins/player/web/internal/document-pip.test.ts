import { describe, expect, mock, spyOn, test } from "bun:test";
import {
  requestPipWindow,
  type DocumentPictureInPicture,
} from "./document-pip";

const SIZE = { width: 560, height: 315 };

function api(result: () => Promise<Window>): DocumentPictureInPicture {
  return { requestWindow: mock(result) };
}

describe("requestPipWindow", () => {
  test("answers the window the browser opened", async () => {
    const win = {} as Window;
    expect(
      await requestPipWindow(
        api(() => Promise.resolve(win)),
        SIZE,
      ),
    ).toBe(win);
  });

  test("a refusal (DOMException) answers null and says why", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const refusal = new DOMException(
      "only allowed from a top-level browsing context",
      "NotAllowedError",
    );
    expect(
      await requestPipWindow(
        api(() => Promise.reject(refusal)),
        SIZE,
      ),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBe(refusal);
    warn.mockRestore();
  });

  test("any other error is a bug and throws", () => {
    expect(
      requestPipWindow(
        api(() => Promise.reject(new TypeError("boom"))),
        SIZE,
      ),
    ).rejects.toThrow("boom");
  });
});
