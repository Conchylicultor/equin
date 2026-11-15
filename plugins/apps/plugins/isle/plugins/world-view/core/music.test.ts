import { describe, expect, test } from "bun:test";
import { AMBIENT_MOODS } from "@plugins/music/plugins/ambient/core";
import { isleStationOf, moodOf, PHASE_MOOD } from "./music";

describe("isle music", () => {
  test("auto follows the time of day", () => {
    expect(moodOf("auto", "day")).toBe("lofi");
    expect(moodOf("auto", "dusk")).toBe("bossa");
    expect(moodOf("auto", "night")).toBe("nocturne");
  });
  test("a held mood ignores the time of day", () => {
    expect(moodOf("ambient", "night")).toBe("ambient");
  });
  test("every phase plays a mood the engine has", () => {
    for (const m of Object.values(PHASE_MOOD))
      expect(AMBIENT_MOODS).toContain(m);
  });
  test("parses stored stations, refusing unknown ones", () => {
    expect(isleStationOf("auto")).toBe("auto");
    expect(isleStationOf("bossa")).toBe("bossa");
    expect(() => isleStationOf("polka")).toThrow();
  });
});
