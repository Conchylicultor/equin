-- singularity:phase expand
-- singularity:phase contract
DROP TABLE "conversation_prompt_hooks" CASCADE;
ALTER TABLE "conversation_turns" DROP COLUMN IF EXISTS "hookless";
-- singularity:claims
-- 20261020_131216__retire_tmux_rows
