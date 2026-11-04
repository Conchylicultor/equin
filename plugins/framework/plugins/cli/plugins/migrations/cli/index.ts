/**
 * Drizzle migration generation for the CLI: the generate/rename/journal
 * pipeline (`migrations.ts`) and the interactive drizzle-kit prompt driver
 * (`migrations-interactive.ts`) that answers its rename/create questions.
 *
 * Its own plugin because three separate commands need it — `build` (which
 * generates a migration as a build stage), `regen-migrations` (which is that
 * stage standalone, for the post-rebase normalize path) and `build`'s hermetic
 * artifact stages — and once each is its own sub-plugin, none of them can reach
 * the host's `bin/`.
 *
 * `migrations.ts` re-exports the interactive module's answer types on purpose,
 * so a caller naming a `MigrationAnswer` does not have to know which of the two
 * files defines it. That is a SAME-PLUGIN re-export and stays legal; this barrel
 * surfaces no other plugin's names.
 */

export {
  answersSidecarName,
  generateMigration,
  journalEntriesForSqlFiles,
  parseMigrationAnswers,
  phaseGeneratedMigrations,
  readBranchLocalAnswers,
  regenerateJournal,
  removeGeneratedFiles,
  renameMigrations,
  writeAnswersSidecar,
} from "./migrations";
export type {
  GenerateMigrationResult,
  JournalEntry,
  KeyedAnswerEntry,
  MigrationPhase,
  RenameResult,
} from "./migrations";

export {
  promptKey,
  resolveAnswer,
  runDrizzleKitWithPrompts,
} from "./migrations-interactive";
export type {
  DetectedPrompt,
  DrizzlePromptResult,
  MigrationAnswer,
  PromptOption,
} from "./migrations-interactive";
