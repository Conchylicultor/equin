// Eagerly pull the declaring module into the web import graph: the
// `mandate.definitions` live value is preloaded (`boot-and-keep` — the options
// of every list's Mandate field), so boot-snapshot must resolve its descriptor
// before first paint, not behind a lazy boundary.
import "../../core";
