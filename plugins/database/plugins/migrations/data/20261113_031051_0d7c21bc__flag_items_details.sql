-- A flag's free-text `reason` becomes `items` (what the user must act on, a
-- jsonb array of sentences) and `details` (the evidence, folded). The new
-- columns are added by this push's expand phase; `reason` is dropped, and
-- `items` made NOT NULL, by its contract. A flag raised before the split keeps
-- its reason as its one item. Idempotent: it runs again before the deferred
-- contract, for flags the previous code wrote in between.
UPDATE "conversation_flags" SET "items" = jsonb_build_array("reason")
  WHERE "items" IS NULL;
