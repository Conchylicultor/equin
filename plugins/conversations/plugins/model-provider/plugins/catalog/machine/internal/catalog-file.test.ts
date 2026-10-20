import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINE_MODELS,
  ConversationModelSchema,
  type ModelCatalog,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  ModelCatalogUnreadableError,
  catalogFromFile,
  readCatalogFile,
  writeCatalogFile,
} from "./catalog-file";

const dir = mkdtempSync(join(tmpdir(), "sg-model-catalog-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the catalog file", () => {
  test("absent reads as the baseline", () => {
    const file = join(dir, "absent", "catalog.json");
    expect(readCatalogFile(file)).toEqual({ kind: "absent" });
    expect(catalogFromFile(file)).toBe(BASELINE_MODELS);
  });

  test("an unreadable file throws rather than forgetting what it held", () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, '{"versions": "nope"}');
    expect(readCatalogFile(file).kind).toBe("invalid");
    expect(() => catalogFromFile(file)).toThrow(ModelCatalogUnreadableError);
  });

  test("a written catalog round-trips, into a directory that did not exist", async () => {
    const file = join(dir, "rw", "catalog.json");
    const catalog: ModelCatalog = {
      ...BASELINE_MODELS,
      versions: [
        ...BASELINE_MODELS.versions,
        {
          id: ConversationModelSchema.parse("sonnet-9"),
          firstSeenAt: "2026-10-02T05:00:00.000Z",
          source: "cli",
        },
      ],
      probedAt: "2026-10-02T05:00:00.000Z",
      cliVersion: "2.2.0",
    };
    await writeCatalogFile(file, catalog);
    expect(catalogFromFile(file)).toEqual(catalog);
  });
});
