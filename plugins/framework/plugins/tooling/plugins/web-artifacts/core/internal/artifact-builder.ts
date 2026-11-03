// How the pipeline builds a stale artifact: through an `ArtifactBuilder`, so
// the caller decides WHERE the compile runs. In-process (the default) every
// build shares this process's one JS thread — Babel and the React Compiler are
// JS, so the pipeline's "concurrent" vite runs were serial (a cold frontend
// used ~1.7 of 6 cores, 2026-11-02). The build CLI passes a pooled builder
// instead (`cli/`: worker threads running `bin/build-worker.ts`).
//
// A request is plain data (`ArtifactBuildRequest`), so it crosses a thread
// boundary; each process builds its own `BuilderCtx` (the Babel contributions)
// once, on its first request.

import { loadBabelContributions } from "@plugins/framework/plugins/web-core/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { ArtifactMeta } from "./store";
import {
  buildArtifact,
  type ArtifactBuildTarget,
  type BuilderCtx,
} from "./vite-builder";

export interface ArtifactBuilder {
  /** Build `target` into the store and return its meta. Throws on a failed build. */
  build(target: ArtifactBuildTarget): Promise<ArtifactMeta>;
}

/** One build, as plain data: what a builder in another thread needs. */
export interface ArtifactBuildRequest {
  repoRoot: AppPath;
  minify: boolean;
  target: ArtifactBuildTarget;
}

/**
 * The request handler every builder runs: the context is built on the first
 * request (after codegen — never at module load) and reused for the handler's
 * life. One handler per pipeline run or per worker; both live no longer than
 * one build.
 */
export function createArtifactBuildHandler(): (
  request: ArtifactBuildRequest,
) => Promise<ArtifactMeta> {
  let ctx: Promise<BuilderCtx> | null = null;
  let ctxFor = "";
  return async (request) => {
    const key = `${request.repoRoot}\0${request.minify}`;
    if (ctx === null) {
      ctxFor = key;
      const pluginsRoot = joinAppPath(request.repoRoot, "plugins");
      ctx = loadBabelContributions({
        pluginsRoot,
        repoRoot: request.repoRoot,
      }).then((babelContributions) => ({
        repoRoot: request.repoRoot,
        pluginsRoot,
        babelContributions,
        minify: request.minify,
      }));
    } else if (key !== ctxFor) {
      throw new Error(
        `artifact build handler: built for ${ctxFor}, asked for ${key} — one handler serves one build`,
      );
    }
    return buildArtifact(request.target, await ctx);
  };
}
