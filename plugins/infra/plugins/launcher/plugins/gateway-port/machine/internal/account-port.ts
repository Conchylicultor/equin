import { rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { z } from "zod";
import { exists, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  GATEWAY_PORT_RANGE,
  LEGACY_GATEWAY_PORT,
} from "@plugins/infra/plugins/namespace/core";
import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { gatewayPortDir, gatewayPortFile } from "../../data-dirs";
import {
  gatewayOriginFor,
  parseGatewayPortRecord,
  renderGatewayPortRecord,
  type GatewayPortRecord,
} from "../../core/internal/port-file";
import { servedGatewayPort } from "../../core/internal/served";

/**
 * The port record, read: `set` with what the file says, or `unset` when there
 * is none — an install that has not chosen its port yet (it still runs on
 * {@link LEGACY_GATEWAY_PORT}) or a fresh one before its first start. Reads
 * only; a malformed file throws. (The CLI's blocking twin is in `cli/`.)
 */
export async function loadGatewayPortRecord(): Promise<
  { kind: "set"; record: GatewayPortRecord } | { kind: "unset" }
> {
  const file = gatewayPortFile();
  if (!(await exists(file))) return { kind: "unset" };
  return {
    kind: "set",
    record: parseGatewayPortRecord(await readFile(file, "utf8"), file),
  };
}

/**
 * Record this account's port. Called only once a gateway answers on it (a
 * start, the follow's switch helper) — so the file never names a port nothing
 * listens on, and a rolled-back move leaves the install on the port it had.
 * Atomic: written beside, then renamed over.
 */
export async function writeGatewayPortRecord(
  record: GatewayPortRecord,
): Promise<void> {
  await gatewayPortDir.ensure();
  const file = gatewayPortFile();
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, renderGatewayPortRecord(record));
  await rename(tmp, file);
}

/**
 * This account's gateway port, for a process acting on the account's gateway
 * from outside it: the gateway that started this process if one did
 * (`EQUIN_GATEWAY_PORT`), else the recorded port, else
 * {@link LEGACY_GATEWAY_PORT} — the port of an install that has not moved yet.
 * The CLI's blocking twin is `gatewayPortSync()` (data-dirs).
 */
export async function resolveGatewayPort(): Promise<number> {
  if (readEnv("GATEWAY_PORT") !== undefined) return servedGatewayPort();
  const read = await loadGatewayPortRecord();
  return read.kind === "set" ? read.record.port : LEGACY_GATEWAY_PORT;
}

/** `http://localhost:<resolveGatewayPort()>` — where `/gateway/*` and central's routes answer. */
export async function resolveGatewayOrigin(): Promise<string> {
  return gatewayOriginFor(await resolveGatewayPort());
}

/** One port of the range a choice skipped, and who holds it. */
export interface SkippedPort {
  port: number;
  /** The listening process (`<command> (pid <n>)`), or null when lsof names none (another account's socket). */
  holder: string | null;
}

/** Whether `port` binds on `host` right now (released at once). */
function bindsOn(port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") resolve(false);
      // No IPv6 loopback on this machine: the gateway degrades to IPv4 there
      // too, so only the IPv4 answer decides.
      else if (err.code === "EADDRNOTAVAIL" && host === "::1") resolve(true);
      else reject(err);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close((err) => (err === undefined ? resolve(true) : reject(err)));
    });
  });
}

/** Whether the gateway could listen on `port`: free on both loopbacks, its own bind shape. */
export async function portIsFree(port: number): Promise<boolean> {
  return (await bindsOn(port, "127.0.0.1")) && (await bindsOn(port, "::1"));
}

/** Who listens on `port`, in words, or null when lsof sees no one (a socket of another account). */
export async function portHolder(port: number): Promise<string | null> {
  const res = await spawnCaptured(
    ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"],
    { timeoutMs: 10_000 },
  );
  // lsof exits 1 when it lists nothing.
  if (res.exitCode === 1) return null;
  if (res.exitCode !== 0) {
    throw new Error(`lsof exited ${res.exitCode}: ${res.stderr}`);
  }
  const pid = /^p(\d+)$/m.exec(res.stdout)?.[1];
  const command = /^c(.+)$/m.exec(res.stdout)?.[1];
  if (pid === undefined) return null;
  return `${command ?? "a process"} (pid ${pid})`;
}

/** The whole range is taken: nothing to choose. */
export class NoFreeGatewayPortError extends Error {
  constructor(readonly skipped: readonly SkippedPort[]) {
    super(
      `Every port equin can use (${GATEWAY_PORT_RANGE.first}–${GATEWAY_PORT_RANGE.last}) is taken:\n` +
        skipped
          .map(
            (s) =>
              `  ${s.port}: ${s.holder ?? "in use by another user account"}`,
          )
          .join("\n") +
        `\nStop one of them, then run \`./equin start\` again.`,
    );
    this.name = "NoFreeGatewayPortError";
  }
}

/**
 * Choose a port for an account that has none: the first of 8700…8709 free on
 * both loopbacks, with every one skipped and its holder. WRITES NOTHING — the
 * caller records it ({@link writeGatewayPortRecord}) once a gateway answers on
 * it. Throws {@link NoFreeGatewayPortError} when the whole range is taken.
 */
export async function chooseGatewayPort(): Promise<{
  port: number;
  skipped: SkippedPort[];
}> {
  const skipped: SkippedPort[] = [];
  for (
    let port: number = GATEWAY_PORT_RANGE.first;
    port <= GATEWAY_PORT_RANGE.last;
    port++
  ) {
    if (await portIsFree(port)) return { port, skipped };
    skipped.push({ port, holder: await portHolder(port) });
  }
  throw new NoFreeGatewayPortError(skipped);
}

/** The plain sentence a start prints about a fresh choice. */
export function describeChoice(choice: {
  port: number;
  skipped: readonly SkippedPort[];
}): string {
  if (choice.skipped.length === 0) return `equin chose port ${choice.port}.`;
  const taken = choice.skipped
    .map((s) => `${s.port} (${s.holder ?? "another user account"})`)
    .join(", ");
  return `equin chose port ${choice.port}: ${taken} ${choice.skipped.length === 1 ? "is" : "are"} taken.`;
}

/** Who answers on a port, as `./equin start` needs to know before it launches. */
export type GatewayProbe =
  | { kind: "none" }
  /** This account's gateway. */
  | { kind: "ours" }
  /** Another equin: another user account's, or another data root's. */
  | { kind: "other-equin"; uid: number; dataDir: string }
  /** Something else entirely (or an equin too old to say who it is). */
  | { kind: "foreign"; holder: string | null };

const IdentitySchema = z.object({
  product: z.string(),
  uid: z.number().int(),
  dataDir: z.string(),
});

/**
 * Who listens on `port`: nothing, this account's gateway, another equin, or
 * something else — read from `GET /gateway/identity`, which only a gateway
 * that knows it answers. A 200 from `/gateway/worktrees` alone (what `start`
 * used to trust) is any equin's, including another account's.
 */
export async function probeGateway(port: number): Promise<GatewayProbe> {
  if (await portIsFree(port)) return { kind: "none" };
  let res: Response;
  try {
    res = await fetch(`${gatewayOriginFor(port)}/gateway/identity`, {
      signal: AbortSignal.timeout(2000),
    });
    // eslint-disable-next-line promise-safety/no-bare-catch -- a listener that does not speak HTTP (or hangs) is, by definition, not an equin gateway: that IS the answer
  } catch {
    return { kind: "foreign", holder: await portHolder(port) };
  }
  if (!res.ok) return { kind: "foreign", holder: await portHolder(port) };
  const parsed = IdentitySchema.safeParse(await res.json());
  if (!parsed.success || parsed.data.product !== "equin") {
    return { kind: "foreign", holder: await portHolder(port) };
  }
  const { uid, dataDir } = parsed.data;
  // The user, not the data root: a path can be spelled two ways (a symlinked
  // home), and a second root under one account (a preview) never takes this
  // account's port.
  return uid === process.getuid?.()
    ? { kind: "ours" }
    : { kind: "other-equin", uid, dataDir };
}
