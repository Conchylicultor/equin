-- Custom SQL migration file, put your code below! --
-- migration: 20261025_032701__notifications_audience_backfill --
-- Before notifications carried an audience, the reports engine's rows
-- ("report") and the legacy crash / DB-fork rows ("crash", "db" — no producer
-- writes them any more) were equin's own telemetry: declared for developers.
UPDATE "notifications" SET "audience" = 'developer' WHERE "type" IN ('report', 'crash', 'db') AND "audience" <> 'developer';
