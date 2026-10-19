import {
  migrationsFrom,
  type Migration,
} from "@plugins/database/plugins/migrations/server";

/**
 * The committed migration history, inlined into the bundle as text by the
 * bundler that builds a browser host (vite rewrites `import.meta.glob` with
 * `?raw` wherever it is written). Its parent's `data/`, read by path because it
 * is data, not a barrel: the browser host's address hashes every file the build
 * loaded, these included. Inside a function, not at module scope: Bun has no
 * `import.meta.glob`, and docgen imports every server barrel under Bun.
 */
export function bundledMigrations(): Migration[] {
  const files = import.meta.glob<string>("../../../../data/*.sql", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  return migrationsFrom(
    Object.entries(files).map(([path, sqlText]) => ({
      file: path.slice(path.lastIndexOf("/") + 1),
      sqlText,
    })),
  );
}
