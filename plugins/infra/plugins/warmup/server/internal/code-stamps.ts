import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _warmupCodeStamps } from "./tables";

/** The code digest recorded by a warm-up's last successful run, if any. */
export async function readCodeStamp(name: string): Promise<string | null> {
  const [row] = await db
    .select({ codeDigest: _warmupCodeStamps.codeDigest })
    .from(_warmupCodeStamps)
    .where(eq(_warmupCodeStamps.name, name));
  return row?.codeDigest ?? null;
}

/** Record that `name` re-derived its state with the code digesting to `digest`. */
export async function writeCodeStamp(
  name: string,
  digest: string,
): Promise<void> {
  await db
    .insert(_warmupCodeStamps)
    .values({ name, codeDigest: digest })
    .onConflictDoUpdate({
      target: _warmupCodeStamps.name,
      set: { codeDigest: digest, derivedAt: new Date() },
    });
}
