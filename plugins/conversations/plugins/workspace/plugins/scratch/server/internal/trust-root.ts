import { ensureDirTrusted } from "../../core";
import { scratchWorkspacesDir } from "../../data-dirs";

/**
 * Trust the scratch root in Claude Code's user config, so a session in any
 * scratch workspace (which inherits its root's trust) never stops at the
 * interactive "Quick safety check" dialog. Runs at every backend boot: a
 * no-op (no write) once the root is trusted. It is a boot step rather than an
 * install-time provision step because only runtime code may read the data-dir
 * declaration (the `provision` folder's boundary row is `provision`, `core`).
 */
export function trustScratchRoot(): void {
  ensureDirTrusted(scratchWorkspacesDir.path);
}
