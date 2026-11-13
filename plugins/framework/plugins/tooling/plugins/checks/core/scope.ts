import type {
  Check,
  CheckScope,
} from "@plugins/framework/plugins/tooling/core";

/**
 * A check's scope, with the default applied. THE one place `?? "tree"` is
 * written — every consumer (the scope filter below, `--list`) reads it through
 * here, so an unclassified check can never mean two different things in two
 * places.
 */
export function scopeOf(check: Check): CheckScope {
  return check.scope ?? "tree";
}
