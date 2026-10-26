-- Custom SQL migration file, put your code below! --
-- migration: 20261025_144630__retire_text_matched_turns --
-- The turn ledger confirms turns by id (research/2026-10-25-conversations-turn-identity-and-fresh-projection.md, A3):
-- the `merged` state (a text match that found the turn inside a longer prompt)
-- and the `unverified` state (a send verdict only the retired tmux runtime
-- produced) are gone. A merged row was confirmed by the agent: it is `accepted`.
-- An unverified row never was: it is `failed`, keeping its error, so its card
-- still offers Retry / Copy to draft. Runs before the contract phase drops
-- `submitted_text` / `extra_text`. Idempotent: it touches only those states.
UPDATE "conversation_turns" SET "state" = 'accepted' WHERE "state" = 'merged';
UPDATE "conversation_turns" SET "state" = 'failed' WHERE "state" = 'unverified';
