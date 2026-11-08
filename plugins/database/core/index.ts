export {
  readDatabaseConfigSync,
  libpqEnvSync,
  buildConnectionString,
  DATABASE_CONFIG_PATH,
} from "./internal/config";
export type { DatabaseConfig, DatabaseProvider } from "./internal/config";
