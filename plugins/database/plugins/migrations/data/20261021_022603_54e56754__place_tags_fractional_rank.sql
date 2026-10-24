-- Custom SQL migration file, put your code below! --
-- migration: 20261021_022603__place_tags_fractional_rank --
-- place_tags moves onto the tag-tree engine: its integer `rank` becomes a
-- fractional key in `tree_rank` (the rank_text domain). Claimed by the
-- place_tags_tree_rank schema migration, so it runs after its expand (the
-- column exists, nullable) and before its contract (SET NOT NULL, DROP rank).
-- Each parent's order is kept exactly: siblings by (rank, created_at, id), the
-- n-th getting 'b' + two base-62 digits — a valid fractional-indexing integer
-- key that sorts in sibling order under C collation (3 844 siblings per
-- parent). Idempotent: only rows still without a tree_rank.
WITH ordered AS (
  SELECT id, (row_number() OVER (PARTITION BY parent_id ORDER BY rank, created_at, id) - 1) AS n
  FROM place_tags)
UPDATE place_tags t
SET tree_rank = 'b'
  || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (o.n / 62)::int + 1, 1)
  || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (o.n % 62)::int + 1, 1)
FROM ordered o
WHERE t.id = o.id AND t.tree_rank IS NULL;
