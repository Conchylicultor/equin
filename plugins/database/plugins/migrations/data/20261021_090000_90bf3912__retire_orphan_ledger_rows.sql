-- Custom SQL migration file, put your code below! --
-- migration: 20261021_090000__retire_orphan_ledger_rows --

-- Retire three ledger rows whose files left main on 2026-05-16, so every boot
-- stops logging them as "applied migration … has no file on this branch".
--
-- 8b757d7b29 hand-wrote two schema migrations under placeholder hashes
-- (a1b2c3d4 add_tasks_group_id, b2c3d4e5 recreate_tasks_v_with_group_id);
-- main applied them, then 0baacfc43c deleted them together with 39a1ca33
-- (dag_schema_apply), folding their DDL into the published history. Main's
-- ledger kept the rows, and every worktree DB forked since inherited them.
-- No file on any branch carries these hashes, so nothing can ever need them.
--
-- IDEMPOTENT and FORK-SAFE: a database without the rows (fresh, or forked
-- after main applied this) deletes nothing.
DELETE FROM __singularity_migrations
  WHERE hash IN ('a1b2c3d4', 'b2c3d4e5', '39a1ca33');
