-- Custom SQL migration file, put your code below! --
-- migration: 20261117_120000__retire_upstream_updates_report --
-- The upstream-updates-available report kind is retired (plugins/upstream):
-- a clone is now measured against upstream's releases, read live as the
-- upstream.release-status value, and nothing files that report any more. Its
-- rows would otherwise sit in Debug → Reports with no kind to validate or
-- render them; their fix-ledger rows go with them (ON DELETE CASCADE).
--
-- Idempotent: a re-run deletes nothing.

DELETE FROM "reports" WHERE "kind" = 'upstream-updates-available';
