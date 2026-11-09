import {
  defineSlot,
  type SealContributions,
} from "@plugins/framework/plugins/web-sdk/core";
import type { ComponentType } from "react";
import type { FileLocation } from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import type { FileViewerGit } from "../core";

/**
 * How well a renderer fits a file:
 * - `native` — the file's own format (markdown preview, an image);
 * - `contextual` — a view the surrounding context makes useful (a diff when the
 *   file is changed);
 * - `fallback` — shows anything of its kind (the code listing);
 * - `last-resort` — offered only when no other renderer is ("No preview");
 * - `false` — not offered.
 * The viewer offers every offered renderer as a tab, best tier first.
 */
export type RendererMatch =
  "native" | "contextual" | "fallback" | "last-resort" | false;

/** What a renderer's `supports()` decides on: the file, plus its context. */
export interface FileRendererTarget {
  file: FileLocation;
  /**
   * The file's git context (its checkout, its path there, and its status vs
   * the checkout's base), when the host knows it — independent of where
   * `file`'s bytes come from, so a host file can carry it too.
   */
  git?: FileViewerGit;
}

/** What a renderer's component is handed. */
export interface FileRendererProps {
  file: FileLocation;
  /** The git context the renderer was offered on (see FileRendererTarget). */
  git?: FileViewerGit;
  /** A 1-based line to reveal and highlight, for renderers that show lines. */
  line?: number;
}

export interface FileRendererContribution {
  id: string;
  label: string;
  supports(target: FileRendererTarget): RendererMatch;
  component: ComponentType<FileRendererProps>;
}

export const FileViewer = {
  Renderer: defineSlot<FileRendererContribution>({ docLabel: (p) => p.label }),
};

const TIER: Record<Exclude<RendererMatch, false>, number> = {
  native: 3,
  contextual: 2,
  fallback: 1,
  "last-resort": 0,
};

/**
 * Sealed view of a renderer contribution as returned by `useContributions()`.
 * Its `component` is opaque (renderable only through `renderIsolated`); every
 * other field (`id`, `label`, `supports`) stays readable for tiering.
 */
export type SealedFileRendererContribution =
  SealContributions<FileRendererContribution>;

export interface ResolvedRenderer {
  contribution: SealedFileRendererContribution;
  tier: Exclude<RendererMatch, false>;
  /**
   * The target the renderer was offered on — FileContent hands its context to
   * the component, so a renderer always mounts with what `supports()` saw.
   */
  target: FileRendererTarget;
}

export function resolveRenderers(
  contributions: readonly SealedFileRendererContribution[],
  target: FileRendererTarget,
): ResolvedRenderer[] {
  const resolved: ResolvedRenderer[] = [];
  for (const c of contributions) {
    const tier = c.supports(target);
    if (tier === false) continue;
    resolved.push({ contribution: c, tier, target });
  }
  resolved.sort((a, b) => TIER[b.tier] - TIER[a.tier]);
  // A last-resort renderer exists to say "nothing else can show this"; beside
  // a renderer that can, it would only be noise.
  const offered = resolved.filter((r) => r.tier !== "last-resort");
  return offered.length > 0 ? offered : resolved;
}
