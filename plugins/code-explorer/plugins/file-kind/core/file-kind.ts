import { symbol, type SymbolRef } from "@plugins/ui/plugins/icons/core";
import { isTestFilePath } from "@plugins/framework/plugins/tooling/plugins/test-layout/core";
import { isGeneratedArtifactPath } from "@plugins/framework/plugins/tooling/plugins/generated-artifacts/core";

/** The kinds, in display order. */
export const FILE_KIND_IDS = ["code", "test", "doc", "generated"] as const;
export type FileKind = (typeof FILE_KIND_IDS)[number];

export interface FileKindInfo {
  readonly id: FileKind;
  /** Singular, sentence case. */
  readonly label: string;
  /** Plural, for a view or a filter summary ("Tests"). */
  readonly pluralLabel: string;
  readonly icon: SymbolRef;
}

/** Every kind with its label and icon, keyed by id (closed: `satisfies` the full set). */
export const FILE_KINDS = {
  code: {
    id: "code",
    label: "Code",
    pluralLabel: "Code",
    icon: symbol("code"),
  },
  test: {
    id: "test",
    label: "Test",
    pluralLabel: "Tests",
    icon: symbol("experiment"),
  },
  doc: {
    id: "doc",
    label: "Doc",
    pluralLabel: "Docs",
    icon: symbol("description"),
  },
  generated: {
    id: "generated",
    label: "Generated",
    pluralLabel: "Generated",
    icon: symbol("settings-suggest"),
  },
} as const satisfies { readonly [K in FileKind]: FileKindInfo & { id: K } };

/**
 * What the file at `repoRelPath` (repo-relative POSIX) is. Precedence:
 * generated, then test, then doc, else code — a generated doc
 * (`docs/plugins-details.md`) or a generated test fixture is generated.
 */
export function fileKindOf(repoRelPath: string): FileKind {
  if (isGeneratedArtifactPath(repoRelPath)) return "generated";
  if (isTestFilePath(repoRelPath) || repoRelPath.endsWith("_test.go")) {
    return "test";
  }
  if (repoRelPath.toLowerCase().endsWith(".md")) return "doc";
  return "code";
}
