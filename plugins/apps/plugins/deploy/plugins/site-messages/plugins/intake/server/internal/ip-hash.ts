import { eq } from "drizzle-orm";
import type { SiteMessagesDb } from "./db";
import { siteMessagesSalt } from "./tables";

const SALT_NAME = "ip-hash";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Per-handle memo: one read per process instead of one per message. Keyed by
// the handle so a test DB never sees the app DB's salt.
const saltMemo = new WeakMap<object, string>();

/** The install's salt, created on first use (concurrent creators converge on one row). */
async function installSalt(dbx: SiteMessagesDb): Promise<string> {
  const memo = saltMemo.get(dbx);
  if (memo !== undefined) return memo;
  await dbx
    .insert(siteMessagesSalt)
    .values({
      name: SALT_NAME,
      salt: hex(crypto.getRandomValues(new Uint8Array(32))),
    })
    .onConflictDoNothing();
  const [row] = await dbx
    .select({ salt: siteMessagesSalt.salt })
    .from(siteMessagesSalt)
    .where(eq(siteMessagesSalt.name, SALT_NAME));
  if (!row) {
    throw new Error(
      "site-messages: the ip-hash salt vanished right after it was ensured",
    );
  }
  saltMemo.set(dbx, row.salt);
  return row.salt;
}

/**
 * `sha256(install salt ‖ ip)`, hex. The IP goes in and is never stored; the
 * salt never leaves the box, so the hash cannot be reversed by trying
 * addresses without it. Web Crypto, so it runs on every host.
 */
export async function ipHash(dbx: SiteMessagesDb, ip: string): Promise<string> {
  const salt = await installSalt(dbx);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}\n${ip}`),
  );
  return hex(new Uint8Array(digest));
}
