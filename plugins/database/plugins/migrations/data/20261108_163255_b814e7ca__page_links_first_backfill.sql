-- Custom SQL migration file, put your code below! --
-- migration: 20261108_163255__page_links_first_backfill --
-- `page_links.first` (the edge of a source page's FIRST linking block into a
-- target, in document order) arrives false on every existing row. Mark one
-- edge per (source, target) pair so no backlink disappears meanwhile: the
-- lowest block id, a stand-in — document order needs the page's block forest,
-- which SQL here does not walk. The boot backfill (`page.links.backfill`)
-- reindexes every live page and corrects it; a trashed source keeps the
-- stand-in until its next edit after a restore.
UPDATE "page_links" AS l
SET "first" = true
FROM (
  SELECT "source_page_id", "target_page_id", min("source_block_id") AS "source_block_id"
  FROM "page_links"
  GROUP BY "source_page_id", "target_page_id"
) AS f
WHERE l."source_page_id" = f."source_page_id"
  AND l."target_page_id" = f."target_page_id"
  AND l."source_block_id" = f."source_block_id"
  AND NOT EXISTS (
    SELECT 1 FROM "page_links" AS o
    WHERE o."source_page_id" = l."source_page_id"
      AND o."target_page_id" = l."target_page_id"
      AND o."first"
  );
