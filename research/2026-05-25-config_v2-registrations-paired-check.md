# config_v2: registrations-paired check

## Context

The config_v2 system has two independent registration mechanisms:
- **Server**: `ConfigV2.Register({ descriptor })` in `contributions[]` of `server/index.ts`
- **Web**: `ConfigV2.WebRegister({ descriptor })` in `contributions[]` of `web/index.ts`

Today 23 plugins register both, perfectly paired — but by convention only. An agent can add a server config without the UI registration (or vice versa) and nothing catches it. This check enforces the pairing at `./equin check` / `./equin push` time.

## Plan

Create a single file: **`plugins/config_v2/check/index.ts`**

The check:
1. Runs `git grep -lF "ConfigV2.Register({"` (all files, no pathspec restriction)
2. Runs `git grep -lF "ConfigV2.WebRegister({"` (same)
3. Filters results to paths ending in `/server/index.ts` and `/web/index.ts` respectively (this excludes definition sites, registry internals, and hook files)
4. Extracts plugin directory by stripping the `/server/index.ts` or `/web/index.ts` suffix
5. Computes symmetric difference of the two plugin-dir sets
6. Reports any unpaired plugin dirs with a hint about what to add

Check ID: `config-v2:registrations-paired`

### Why filter in JS, not via git pathspec

`git grep -- "*/server/index.ts"` won't match deeply nested plugins (e.g. `plugins/ui/plugins/tokens/plugins/chart/server/index.ts`) because `*` doesn't match `/` in pathspecs containing slashes. Filtering in JS with `path.endsWith("/server/index.ts")` is simpler and correct.

### Why `ConfigV2.Register({` (with trailing `({`)

This cleanly excludes:
- The definition site (`defineServerContribution<ConfigRegistration>("ConfigV2.Register")`)
- The registry's `.getContributions()` calls
- Error message strings in `use-config.ts` / `use-set-config.ts`

No ALLOWED_PATHS exclusion list needed.

### Implementation

```ts
type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

async function getRoot(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (await new Response(proc.stdout).text()).trim();
}

async function grepPluginDirs(
  root: string,
  pattern: string,
  suffix: string,
): Promise<Set<string>> {
  const proc = Bun.spawn(["git", "grep", "-lF", "--", pattern], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  if (!out) return new Set();
  const dirs = new Set<string>();
  for (const line of out.split("\n")) {
    const path = line.trim();
    if (!path.endsWith(suffix)) continue;
    dirs.add(path.slice(0, path.length - suffix.length));
  }
  return dirs;
}

const check: Check = {
  id: "config-v2:registrations-paired",
  description:
    "Every ConfigV2.Register (server) must have a matching ConfigV2.WebRegister (web), and vice versa",
  async run() {
    const root = await getRoot();

    const [serverDirs, webDirs] = await Promise.all([
      grepPluginDirs(root, "ConfigV2.Register({", "/server/index.ts"),
      grepPluginDirs(root, "ConfigV2.WebRegister({", "/web/index.ts"),
    ]);

    const missingWeb: string[] = [];
    const missingServer: string[] = [];

    for (const dir of serverDirs) {
      if (!webDirs.has(dir)) missingWeb.push(dir);
    }
    for (const dir of webDirs) {
      if (!serverDirs.has(dir)) missingServer.push(dir);
    }

    if (missingWeb.length === 0 && missingServer.length === 0) return { ok: true };

    missingWeb.sort();
    missingServer.sort();

    const parts: string[] = [];
    if (missingWeb.length > 0) {
      parts.push(
        `${missingWeb.length} plugin(s) have ConfigV2.Register (server) but no ConfigV2.WebRegister (web):\n` +
          missingWeb.map((d) => `    ${d}`).join("\n"),
      );
    }
    if (missingServer.length > 0) {
      parts.push(
        `${missingServer.length} plugin(s) have ConfigV2.WebRegister (web) but no ConfigV2.Register (server):\n` +
          missingServer.map((d) => `    ${d}`).join("\n"),
      );
    }

    return {
      ok: false,
      message: parts.join("\n\n"),
      hint: [
        missingWeb.length > 0 &&
          "Add ConfigV2.WebRegister({ descriptor }) to the web/index.ts contributions[] of each listed plugin.",
        missingServer.length > 0 &&
          "Add ConfigV2.Register({ descriptor }) to the server/index.ts contributions[] of each listed plugin.",
      ]
        .filter(Boolean)
        .join(" "),
    };
  },
};

export default check;
```

## Files to create/modify

| File | Action |
|---|---|
| `plugins/config_v2/check/index.ts` | Create — the check implementation above |

`./equin build` will auto-regenerate `check.generated.ts` to pick up the new entry. No manual registration needed.

## Verification

1. `./equin build` — regenerates `check.generated.ts`
2. `./equin check --config-v2:registrations-paired` — should pass (all 23 are paired today)
3. To test failure: temporarily remove the `ConfigV2.WebRegister` line from any plugin's `web/index.ts`, re-run the check, confirm it reports the mismatch, then restore.

## Reference files

- `plugins/infra/plugins/paths/check/index.ts` — canonical check pattern (Bun.spawn, getRoot, git grep)
- `plugins/config_v2/server/internal/contribution.ts` — server contribution token definition
- `plugins/config_v2/web/internal/slots.ts` — web slot definition
