import { expect, test } from "bun:test";
// Importing this module IS the second assertion: `defineRetention` throws at call
// time if `column` names a column the table lacks, so renaming `createdAt` fails
// here loudly instead of at server boot.
import { entityVersionsRetention } from "./retention";

test("entityVersionsRetention pins the dedup/cron job id", () => {
  expect(entityVersionsRetention.name).toBe("retention.entity_versions");
});
