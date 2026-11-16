-- Custom SQL migration file, put your code below! --
-- migration: 20261116_020330__usage_files_one_row_per_transcript --
--
-- One conversation_usage_files row per transcript. The data-root move
-- (infra/paths/root-migration) renamed every Claude Code project dir under the
-- old data root (`-Users-<u>--singularity-state-*` → `…--equin-state-*`) but
-- not the rows that had counted their files, and the usage sync then matched
-- rows by full path: a chain re-resolved since counted the renamed file again
-- from zero, under a second row (58 transcripts on main, 2026-11-16). The sync
-- now matches rows by transcript (conversations/usage
-- machine/internal/transcript-key.ts: the path from the session-id segment
-- on, whichever project dir holds it); this drops the second count already
-- stored, keeping per transcript the row read furthest (a tie, the same count:
-- the lexically smaller path), so the history import files each transcript once.
--
-- Idempotent (a re-run finds one row per transcript) — claimed with the group
-- it lands in, the deferred contract re-runs it after the previous backend,
-- still matching by path, is gone.
DELETE FROM conversation_usage_files f
 USING conversation_usage_files k
 WHERE f.conversation_id = k.conversation_id
   AND f.path <> k.path
   AND substring(f.path from '/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.jsonl)?(/.*)?)$')
     = substring(k.path from '/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.jsonl)?(/.*)?)$')
   AND (k."offset" > f."offset" OR (k."offset" = f."offset" AND k.path < f.path));
