// The schema probe's wire shapes (`schema-probe.ts` writes them, `run-probe.ts`
// reads them).

/** An export the check needs evaluated: `<exportName>.<path…>` of `file`. */
export interface ExportRef {
  readonly id: string;
  /** Absolute path of a schema-glob file. */
  readonly file: string;
  readonly exportName: string;
  readonly path: readonly string[];
}

export interface ProbeInput {
  /** Absolute schema-glob files. */
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
  /** The schema file exporting it (absolute). */
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
