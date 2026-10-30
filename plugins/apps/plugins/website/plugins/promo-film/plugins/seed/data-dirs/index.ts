import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The film's on-disk workspace: the folder its conversation's agent worked in
 * (`att-…/`, as an agent's worktree is named) — the practice MIDI file, the
 * notes and the script the transcript shows being written. The conversation's
 * attempt points here, so its file chips, the file preview and Files read real
 * files. Rewritten whole by every `./equin promo-film seed`.
 */
export const promoFilmWorkspaceDir = defineDataDir({
  kind: "cache",
  name: "promo-film",
  owner: "apps/website/promo-film/seed",
  description:
    "The showcase film's workspace folder (the files its seeded conversation wrote), rewritten by ./equin promo-film seed",
  reclaim: { kind: "safe" },
});

export default [promoFilmWorkspaceDir];
