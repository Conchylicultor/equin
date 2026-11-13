// The schema probe's shapes: what `schema.question.ts` answers per schema
// file, and the model `run-probe.ts` assembles from those answers.

/** An export the check needs evaluated: `<exportName>.<path…>` of `file`. */
export interface ExportRef {
  readonly id: string;
  /** A schema-glob file, repo-relative. */
  readonly file: string;
  readonly exportName: string;
  readonly path: readonly string[];
}

export interface ProbeInput {
  /** The schema-glob files, repo-relative. */
  readonly files: readonly string[];
  readonly refs: readonly ExportRef[];
}

/** An export reference as one file's question input: the file is implied. */
export type FileRef = Omit<ExportRef, "file">;

/** What the schema question answers about one schema file that loaded. */
export interface ProbeFileAnswer {
  readonly tables: readonly ProbeTable[];
  readonly refs: Readonly<Record<string, ResolvedRef>>;
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
