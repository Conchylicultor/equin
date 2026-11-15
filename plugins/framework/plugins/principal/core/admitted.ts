import { principalOf } from "./principal";
import { principalStamp } from "./stamp";

/**
 * Who a request a host already admitted is, for a decision finer than its
 * route's — a live resource's own `access` behind the `{ visitor }` live-state
 * routes. The owner or a visitor, nothing else: the gate refused anyone else.
 *
 * - Not stamped (a gateway older than the stamp) or undeclared (the in-realm
 *   browser host, whose only caller is the page; a test): `owner` — the host
 *   serves every route ungated, so this answer matches what admitted it.
 * - Stamped: `owner` only on an `owner` stamp; anything else is a `visitor`,
 *   the narrowest caller a `{ visitor }` route admits (fail closed).
 */
export function admittedAs(req: Request): "owner" | "visitor" {
  if (principalStamp() !== "stamped") return "owner";
  return principalOf(req).kind === "owner" ? "owner" : "visitor";
}
