-- The queue's `pinned` flag becomes the reserved section key 'pinned' (the
-- section column is added by this push's expand phase, `pinned` dropped by its
-- contract). Idempotent: it runs again before the deferred contract.
UPDATE "conversations_ext_queue" SET "section" = 'pinned' WHERE "pinned" AND "section" IS NULL;
