import type { ConfigDescriptor } from "./types";
import type { JsonValue } from "./types";
import type { FieldsRecord } from "@plugins/fields/core";

/** One config file's parsed content: its document and the `// @hash` it records. */
export interface ConfigFileContent {
  content: JsonValue;
  hash: string | null;
}

export interface ConfigProxy {
  read(): ConfigFileContent | null;
  write(content: JsonValue, hash: string | null): void;
  exists(): boolean;
}

/**
 * A file already read (`ConfigStoreImpl.read`), as the tier cascade reads it:
 * `exists` and `read` answer from the one read, so every question the cascade
 * asks about the file is answered from the same content. Read-only — a write
 * goes through the store.
 */
export function loadedProxy(data: ConfigFileContent | null): ConfigProxy {
  return {
    read() {
      return data;
    },
    write() {
      throw new Error(
        "loadedProxy is read-only — write through the config store",
      );
    },
    exists() {
      return data !== null;
    },
  };
}

// Pure JS hash — not cryptographic, just for config change detection.
// Produces 12 hex chars (48 bits) from two independent multiply-xorshift accumulators.
export function computeHash(content: JsonValue): string {
  const str = JSON.stringify(content);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x9e3779b9);
    h2 = Math.imul(h2 ^ ch, 0x5f356495);
  }
  h1 ^= Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b);
  h2 ^= Math.imul(h2 ^ (h2 >>> 16), 0xc2b2ae35);
  return (
    (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0")
  ).slice(0, 12);
}

/**
 * THE canonical config value serializer — 2-space-indented JSON, re-indented so
 * every line after the first sits under `indent`. Used by BOTH the runtime
 * override writer (`jsoncConfigProxy.write`, `indent = ""`) and the build-time
 * origin generator (`renderFieldLines`, where `indent` is the field's nesting).
 * One serializer means committed origins and user overrides format arrays/objects
 * identically (one element per line). Formatting never affects `computeHash`
 * (which hashes the compact value), so re-indenting is purely cosmetic.
 */
export function stringifyConfigValue(value: unknown, indent = ""): string {
  const json = JSON.stringify(value, null, 2);
  if (!indent) return json;
  return json
    .split("\n")
    .map((line, i) => (i === 0 ? line : indent + line))
    .join("\n");
}

export function codeConfigProxy<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
): ConfigProxy {
  return {
    read() {
      return {
        content: descriptor.defaults as unknown as JsonValue,
        hash: null,
      };
    },
    write() {
      throw new Error("codeConfigProxy is read-only");
    },
    exists() {
      return true;
    },
  };
}

export function readonlyProxy(content: JsonValue): ConfigProxy {
  return {
    read() {
      return { content, hash: null };
    },
    write() {
      throw new Error("readonlyProxy is read-only");
    },
    exists() {
      return true;
    },
  };
}
