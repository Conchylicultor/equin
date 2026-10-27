// FIRST: the page request guard must be in place before any other module
// evaluates (see install-request-guard.ts).
import "./install-request-guard";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css";
import { markBootInstant } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/web";
import App from "./App";

markBootInstant("module-eval", "scripts", "main.tsx eval");

// NOTE: the `.experimental` frame is NOT decided here. The browser cannot tell a
// git-worktree namespace from a composition namespace or a release preview —
// they all live at `<name>.localhost` — so the class is stamped into the served
// index.html by whoever built the dist. See the CLI's experimental-marker.ts.

markBootInstant("create-root", "scripts", "createRoot");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
