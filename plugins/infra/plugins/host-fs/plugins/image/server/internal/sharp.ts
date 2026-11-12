// sharp, loaded on first use rather than with the plugin.
//
// Importing sharp dlopens its native libvips module, ~0.26 s of CPU on the
// main thread — and the image plugin's machine half was imported by every
// backend's boot, before it could serve, for routes only an image grid calls.
// Nothing a tab waits on at boot needs it, so it loads the first time an image
// is measured or resized, once per process; later callers share the promise.
// The specifier is literal, so a source digest still follows it.

type Sharp = typeof import("sharp").default;

let loaded: Promise<Sharp> | null = null;

export function loadSharp(): Promise<Sharp> {
  loaded ??= import("sharp").then((m) => m.default);
  return loaded;
}
