// The schema probe's wire shapes (`schema-probe.ts` writes them, `run-probe.ts`
// reads them).

/** An export the check needs evaluated: `<exportName>.<path…>` of `file`. */
export interface ExportRef {
  readonly id: string;
  /** A schema-glob file, repo-relative. */
  readonly file: string;
  readonly exportName: string;
  readonly path: readonly string[];
}

export interface ProbeInput {
  /** The schema-glob files, repo-relative — the probe resolves them against
   *  the checkout root it is handed apart (argv), so the input names no
   *  checkout and its answer is a record every checkout shares. */
  readonly files: readonly string[];
  readonly refs: readonly ExportRef[];
}

/** Why no write may name a column. */
export type Unwritten = "generated" | "derived-updated-at";

export interface ProbeColumn {
  /** Physical name. */
  readonly name: string;
  /** An INSERT must name it: NOT NULL, and nothing in the database fills it. */
  readonly required: boolean;
  readonly unwritten: Unwritten | null;
}

export interface ProbeTable {
  readonly schema: string;
  readonly name: string;
  /** The schema file exporting it, repo-relative. */
  readonly file: string;
  readonly columns: readonly ProbeColumn[];
}

export type ResolvedRef =
  | { readonly kind: "table"; readonly schema: string; readonly name: string }
  | {
      readonly kind: "column";
      readonly schema: string;
      readonly table: string;
      readonly name: string;
    }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "other"; readonly what: string };

export interface ProbeOutput {
  readonly tables: readonly ProbeTable[];
  /** `IMPERATIVE_PUBLIC_TABLES`' values: public tables created outside drizzle. */
  readonly imperative: readonly string[];
  readonly refs: Readonly<Record<string, ResolvedRef>>;
  readonly loadFailures: readonly { file: string; error: string }[];
}
