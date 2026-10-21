import { expect, test } from "bun:test";
import { configLedgerDocument, configLedgerKey } from "./config-ledger-key";

test("the base scope is named by its store path alone", () => {
  const key = configLedgerKey("apps/runs/views.jsonc", "");
  expect(key).toBe("apps/runs/views.jsonc");
  expect(configLedgerDocument(key)).toEqual({
    storePath: "apps/runs/views.jsonc",
    scopeId: "",
  });
});

test("a scoped document round-trips", () => {
  const key = configLedgerKey("ui/theme-engine/theme.jsonc", "app:pages");
  expect(key).toBe("ui/theme-engine/theme.jsonc @app:pages");
  expect(configLedgerDocument(key)).toEqual({
    storePath: "ui/theme-engine/theme.jsonc",
    scopeId: "app:pages",
  });
});

test("an input that would make the key ambiguous is refused", () => {
  expect(() => configLedgerKey("odd @name.jsonc", "")).toThrow(/neither may/);
  expect(() => configLedgerKey("a.jsonc", "app: @x")).toThrow(/neither may/);
});
