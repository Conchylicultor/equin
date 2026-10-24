import { z } from "zod";

/**
 * The OS account this equin instance runs as — one instance per user, so
 * it is the user's own account (`research/2026-07-02-global-adr-single-instance-per-user.md`).
 *
 * - `username` — the login name (`os.userInfo().username`), always known.
 * - `fullName` — the account's full name as the OS records it (macOS
 *   `id -F`, the passwd GECOS field elsewhere), or `null` when the account
 *   carries none. `null` is a fact about the account, not a failed read: a
 *   read that fails throws instead.
 */
export const HostAccountSchema = z.object({
  username: z.string().min(1),
  fullName: z.string().min(1).nullable(),
});
export type HostAccount = z.infer<typeof HostAccountSchema>;

/** The name to show for the account: its full name, else its login name. */
export function accountDisplayName(account: HostAccount): string {
  return account.fullName ?? account.username;
}

/** The first word of {@link accountDisplayName} ("Etienne" for "Etienne Pot"). */
export function accountFirstName(account: HostAccount): string {
  const name = accountDisplayName(account);
  return name.split(/\s+/)[0] ?? name;
}

/** The account's initial, upper-cased — what a one-letter avatar tile shows. */
export function accountInitial(account: HostAccount): string {
  // Spread, not `[0]`: a name starting with an astral character (an emoji, a
  // supplementary-plane letter) would otherwise yield half a surrogate pair.
  const [first] = [...accountFirstName(account)];
  return (first ?? "?").toLocaleUpperCase();
}
