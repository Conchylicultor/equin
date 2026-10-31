import { describe, expect, test } from "bun:test";
import { pickIncidentBell } from "./incident";

describe("pickIncidentBell", () => {
  test("nothing ringing rings nothing", () => {
    expect(pickIncidentBell([])).toBeNull();
  });

  test("the lead rings when every report is known", () => {
    expect(
      pickIncidentBell([{ isNew: false }, { isNew: false }, { isNew: false }]),
    ).toEqual({ index: 0, fresh: 0 });
  });

  test("the first new report rings over the lead, counting every new one", () => {
    expect(
      pickIncidentBell([
        { isNew: false },
        { isNew: true },
        { isNew: false },
        { isNew: true },
      ]),
    ).toEqual({ index: 1, fresh: 2 });
  });

  test("a new lead rings as itself", () => {
    expect(pickIncidentBell([{ isNew: true }, { isNew: false }])).toEqual({
      index: 0,
      fresh: 1,
    });
  });
});
