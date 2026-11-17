/**
 * Tests for `no-blob-in-state` — a type-aware rule: each case is linted as a
 * virtual `case.tsx` beside this file under an inferred project.
 */

import { setDefaultTimeout } from "bun:test";
import { createTypedRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-blob-in-state";

// The first case pays for building the inferred project's program.
setDefaultTimeout(60_000);

const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const VIRTUAL_CASE = "case.tsx";
const FILENAME = `${LINT_DIR}/${VIRTUAL_CASE}`;

const PRELUDE = `
declare class Blob { size: number }
declare class File extends Blob { name: string }
declare class MediaStream { id: string }
interface RefObject<T> { current: T }
declare function useState<S>(init: S | (() => S)): [S, (s: S) => void];
declare function useState<S = undefined>(): [S | undefined, (s: S) => void];
declare function useRef<T>(init: T): RefObject<T>;
declare function useReducer<S, A>(r: (s: S, a: A) => S, init: S): [S, (a: A) => void];
declare const React: { useState: typeof useState };
declare const file: File;
declare function useBlobLoader(): Blob;
`;

const valid = (code: string) => ({ filename: FILENAME, code: PRELUDE + code });
const invalid = (code: string) => ({
  filename: FILENAME,
  code: PRELUDE + code,
  errors: [{ messageId: "blobInState" as const }],
});

const ruleTester = createTypedRuleTester({
  dir: LINT_DIR,
  cases: [VIRTUAL_CASE],
  jsx: true,
});

ruleTester.run("no-blob-in-state", rule, {
  valid: [
    valid(`const [id, setId] = useState<string | null>(null);`),
    valid(`const ref = useRef<HTMLDivElement | null>(null);`),
    valid(`const [n] = useReducer((s: number, a: number) => s + a, 0);`),
    // A blob read from elsewhere, not held in state.
    valid(`const b = useBlobLoader();`),
  ],
  invalid: [
    invalid(`const [b, setB] = useState<Blob | null>(null);`),
    invalid(`const [f] = useState(file);`),
    invalid(`const [fs] = useState<File[]>([]);`),
    invalid(`const [b] = React.useState<Blob | null>(null);`),
    invalid(`const r = useRef<MediaStream | null>(null);`),
    invalid(`const [s] = useReducer((s: Blob | null, a: Blob) => a, null);`),
  ],
});
