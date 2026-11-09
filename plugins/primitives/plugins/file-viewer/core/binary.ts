import { fileExtension } from "./file-git";

// Extensions whose bytes are not text a code listing could show. Decided by
// name alone, so `supports()` can answer synchronously: the code renderer
// steps aside for these, leaving them to a renderer of their own format or to
// the last-resort "No preview".
// A file outside this set that turns out binary is still caught at read time —
// the text read answers 415 and the code renderer shows the same fallback.
const BINARY_EXTENSIONS = new Set([
  // images (the image renderer shows them; svg is text and stays out)
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "bmp",
  "avif",
  "heic",
  "tif",
  "tiff",
  // documents
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "key",
  "pages",
  "numbers",
  // archives and disk images
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "dmg",
  "pkg",
  "iso",
  // executables and object code
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "o",
  "a",
  "class",
  "jar",
  "wasm",
  // audio and video
  "mp3",
  "mp4",
  "mov",
  "m4v",
  "ogv",
  "wav",
  "flac",
  "ogg",
  "m4a",
  "aac",
  "opus",
  "oga",
  "webm",
  "mkv",
  "avi",
  "mid",
  "midi",
  // fonts
  "ttf",
  "otf",
  "woff",
  "woff2",
  // databases and design files
  "sqlite",
  "db",
  "psd",
  "sketch",
  "fig",
]);

/** Whether the path's extension names a binary format (by name, not bytes). */
export function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(fileExtension(path));
}
