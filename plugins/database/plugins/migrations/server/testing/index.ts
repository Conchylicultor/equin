// For DB test suites that build a throwaway database's own tables
// (`createTestDb` + `runMigrations`). Boot runs `applySchemaLayer`.
export { runMigrations } from "./run-migrations";
