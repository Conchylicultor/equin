-- Custom SQL migration file, put your code below! --
-- migration: 20261116_123952__usage_scan_rows_store_transcript_keys --
--
-- The usage scan tables store a transcript by its key, not its absolute path.
-- `conversation_usage_files.path` (and `claude_transcript_scans.path`) held
-- `~/.claude/projects/<project dir>/<sessionId>…`, and the project dir moves
-- when its cwd's name does: the data-root move (infra/paths/root-migration)
-- renamed the dirs under the old data root but not these rows (109
-- conversations on main kept the old spelling only). The scanners now store
-- the transcript key (conversations/usage machine/internal/transcript-key.ts:
-- the path from the session-id segment on, `<sessionId>.jsonl` or
-- `<sessionId>/subagents/…`), so no rename can strand a row again; this
-- rewrites the conversation rows already stored. A transcript stored under
-- two spellings keeps one row: the one read furthest (a tie: the one already
-- a key, then the lexically smaller path) — such a pair is one count
-- continued under two spellings (the previous backend, mid hot-restart,
-- advancing the absolute row it held), so nothing is given back. The previous
-- backend reads keyed conversation rows (it matches them by key), so keying
-- them at boot is safe; `claude_transcript_scans` rows are NOT keyed here —
-- that backend matches them by absolute path and would count a keyed one again
-- from zero — but by the `conversations.usage.scan-keys` job once it is gone.
--
-- The key of an absolute path: its first session-id segment on (the regex
-- below; a path with none is its own key). A key never starts with `/`.
--
-- Also: `claude_usage_sources` rows written under the old data root's dir
-- name (`-<home>--singularity-state-…`) keep that name and were classified as
-- this repo's (`is_repo`): the old root's name contains the repo's. They are
-- the data root's scratch workspaces, never a checkout — rewritten to the
-- name the dir has now, not the repo's, as every row written since is.
--
-- Idempotent (a re-run finds keys only, and no old dir name): claimed with the
-- schema group it lands in, the deferred contract re-runs it once the
-- previous backend, which still wrote absolute paths, is gone.
DELETE FROM conversation_usage_files f
 USING conversation_usage_files k
 WHERE f.conversation_id = k.conversation_id
   AND f.path <> k.path
   AND (CASE WHEN f.path LIKE '/%' THEN coalesce(substring(f.path from '/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.jsonl)?(/.*)?)$'), f.path) ELSE f.path END)
     = (CASE WHEN k.path LIKE '/%' THEN coalesce(substring(k.path from '/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.jsonl)?(/.*)?)$'), k.path) ELSE k.path END)
   AND (k."offset" > f."offset"
     OR (k."offset" = f."offset" AND k.path NOT LIKE '/%' AND f.path LIKE '/%')
     OR (k."offset" = f."offset" AND (k.path LIKE '/%') = (f.path LIKE '/%') AND k.path < f.path));

UPDATE conversation_usage_files
   SET path = substring(path from '/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.jsonl)?(/.*)?)$')
 WHERE path LIKE '/%'
   AND substring(path from '/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.jsonl)?(/.*)?)$') IS NOT NULL;

UPDATE claude_usage_sources
   SET project_dir = replace(project_dir, '--singularity-state-', '--equin-state-'),
       is_repo = false
 WHERE project_dir LIKE '%--singularity-state-%';
