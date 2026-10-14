import type { MailThreadRow } from "../../core";

// A compact one-line label for a thread row's left column: the display names (or
// email local-parts) of the thread's participants. The thread stores a single
// merged `participants` list (not separate from/to), so this summarizes whoever
// is on the thread. De-duplicated, capped to keep the row single-line.
export function senderSummary(thread: MailThreadRow): string {
  const names = thread.participants
    .map(addressLabel)
    .filter((s) => s.length > 0);
  const unique = [...new Set(names)];
  if (unique.length === 0) return "(unknown)";
  if (unique.length <= 3) return unique.join(", ");
  return `${unique.slice(0, 2).join(", ")} +${unique.length - 2}`;
}

function addressLabel(addr: { name?: string; email: string }): string {
  const name = addr.name?.trim();
  if (name) return name;
  const email = addr.email ?? "";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
