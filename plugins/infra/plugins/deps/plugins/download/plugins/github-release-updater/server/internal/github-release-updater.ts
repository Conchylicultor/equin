import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { declaredDeps } from "@plugins/infra/plugins/deps/deps";
import {
  GITHUB_RELEASE_UPDATER_ID,
  GithubReleasePinSchema,
  githubReleaseAssetName,
  isGithubReleaseDownload,
  type GithubReleasePin,
} from "@plugins/infra/plugins/deps/plugins/download/deps";
import {
  cooldownEnd,
  heldWaiting,
  type Cooldown,
  type Move,
  type Outdated,
  type Updater,
  type UpdaterPlan,
} from "@plugins/infra/plugins/deps/plugins/updates/core";
import {
  heldBy,
  utcDay,
  type Hold,
} from "@plugins/infra/plugins/deps/plugins/hold/core";
import {
  GITHUB_RELEASE_HOLDS,
  GITHUB_RELEASE_HOLDS_FILE,
} from "@plugins/infra/plugins/deps/plugins/download/plugins/github-release-updater/core";

const MINUTE = 60_000;

/** How long a release must have been public before the updater adopts it (as npm, uv, cargo). */
export const GITHUB_RELEASE_COOLDOWN_DAYS = 3;

/**
 * The order release tags are compared by (a `below` hold): their dotted
 * numbers, a leading `v` ignored; negative when `a` is older.
 */
export function compareReleaseTags(a: string, b: string): number {
  const nums = (v: string) =>
    (/^v?(\d+(?:\.\d+)*)/.exec(v)?.[1] ?? "").split(".").map(Number);
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p !== q) return p - q;
  }
  return 0;
}

/** One published release, as the updater needs it. */
export interface Release {
  tag: string;
  publishedAt: string;
  /** Each asset's name → its lowercase sha256, or null when GitHub reports no digest. */
  assets: ReadonlyMap<string, string | null>;
}

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable(),
  assets: z.array(
    z.object({ name: z.string(), digest: z.string().nullable().optional() }),
  ),
});

function toRelease(r: z.infer<typeof releaseSchema>): Release | null {
  if (r.draft || r.prerelease || r.published_at === null) return null;
  return {
    tag: r.tag_name,
    publishedAt: new Date(r.published_at).toISOString(),
    assets: new Map(
      r.assets.map((a) => [
        a.name,
        a.digest?.startsWith("sha256:") === true
          ? a.digest.slice("sha256:".length).toLowerCase()
          : null,
      ]),
    ),
  };
}

async function github(path: string): Promise<unknown> {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    headers: {
      // GitHub refuses requests without a User-Agent.
      "User-Agent": "equin-deps-github-release-updater",
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(MINUTE),
  });
  if (!res.ok) throw new Error(`GitHub ${url} answered ${res.status}`);
  return res.json();
}

/** The repository's latest published releases (drafts and pre-releases left out), newest first. */
async function recentReleases(repo: string): Promise<Release[]> {
  const page = z
    .array(releaseSchema)
    .parse(await github(`/repos/${repo}/releases?per_page=30`));
  return page
    .map(toRelease)
    .filter((r): r is Release => r !== null)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/**
 * The release a pin moves to: the newest one published after the pin's, at
 * or before `cutoff`, carrying the pin's asset, not held. `null` when none.
 */
export function pickRelease(
  releases: readonly Release[],
  depId: string,
  pin: GithubReleasePin,
  cutoff: string,
  holds: readonly Hold[],
): Release | null {
  for (const r of releases) {
    if (r.publishedAt <= pin.publishedAt || r.tag === pin.tag) continue;
    if (r.publishedAt > cutoff) continue;
    if (!r.assets.has(githubReleaseAssetName(pin.asset, r.tag))) continue;
    if (heldBy(holds, depId, r.tag, compareReleaseTags)) continue;
    return r;
  }
  return null;
}

/** The newest instant a move may adopt: start of today (UTC) minus the cooldown, or now when skipped. */
export function releaseCutoff(now: Date, cooldown: Cooldown): string {
  if (cooldown === "skip") return now.toISOString();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return new Date(
    today - GITHUB_RELEASE_COOLDOWN_DAYS * 86_400_000,
  ).toISOString();
}

/**
 * One pin's row, or none when it is on its newest release: a move past the
 * cooldown and the holds, else the newest release still cooling down
 * (WAITING), else a held one — so a release is never silently skipped.
 */
export function releaseRow(args: {
  depId: string;
  pin: GithubReleasePin;
  releases: readonly Release[];
  now: Date;
  cooldown: Cooldown;
  holds: readonly Hold[];
}): Outdated | null {
  const { depId, pin, releases, now, cooldown, holds } = args;
  const row = (latest: string) => ({
    name: depId,
    current: pin.tag,
    latest,
  });
  const target = pickRelease(
    releases,
    depId,
    pin,
    releaseCutoff(now, cooldown),
    holds,
  );
  if (target !== null) return row(target.tag);
  const everything = now.toISOString();
  const fresh = pickRelease(releases, depId, pin, everything, holds);
  if (fresh !== null) {
    return {
      ...row(fresh.tag),
      waiting: {
        kind: "awaiting",
        on: {
          kind: "cooldown",
          of: [depId],
          until: cooldownEnd(fresh.publishedAt, GITHUB_RELEASE_COOLDOWN_DAYS),
        },
      },
    };
  }
  const newest = pickRelease(releases, depId, pin, everything, []);
  if (newest === null) return null;
  const hold = heldBy(holds, depId, newest.tag, compareReleaseTags)!;
  return { ...row(newest.tag), waiting: heldWaiting(hold, utcDay(now)) };
}

/** Every declared github-release pin: the dependency id and its pin file. */
async function pinnedDeps(): Promise<Array<{ id: string; pinFile: string }>> {
  return (await declaredDeps()).flatMap((d) =>
    isGithubReleaseDownload(d.source)
      ? [{ id: d.id, pinFile: d.source.release.pinFile }]
      : [],
  );
}

/** The pin as `root`'s file says it — the file, not this process's import, is what a move rewrites. */
async function readPin(
  root: AppPath,
  pinFile: string,
): Promise<GithubReleasePin> {
  const text = await readFile(joinAppPath(root, pinFile), "utf8");
  return GithubReleasePinSchema.parse(JSON.parse(text));
}

async function rows(root: AppPath, cooldown: Cooldown): Promise<Outdated[]> {
  const now = new Date();
  const out: Outdated[] = [];
  for (const { id, pinFile } of await pinnedDeps()) {
    const pin = await readPin(root, pinFile);
    const row = releaseRow({
      depId: id,
      pin,
      releases: await recentReleases(pin.repo),
      now,
      cooldown,
      holds: GITHUB_RELEASE_HOLDS,
    });
    if (row !== null) out.push(row);
  }
  return out;
}

/** The pin a move writes: the release's tag, publish instant and the asset's digest. */
export function movedPin(
  pin: GithubReleasePin,
  release: Release,
): GithubReleasePin {
  const asset = githubReleaseAssetName(pin.asset, release.tag);
  if (!release.assets.has(asset)) {
    throw new Error(
      `${pin.repo} ${release.tag} has no asset ${asset}; its assets are ${[...release.assets.keys()].join(", ")}`,
    );
  }
  const sha256 = release.assets.get(asset) ?? null;
  if (sha256 === null) {
    throw new Error(
      `GitHub reports no sha256 digest for ${pin.repo} ${release.tag}'s ${asset}, so there is nothing to pin it by`,
    );
  }
  return { ...pin, tag: release.tag, publishedAt: release.publishedAt, sha256 };
}

export const githubReleaseUpdater: Updater = {
  id: GITHUB_RELEASE_UPDATER_ID,
  description: `Every githubReleaseDownload's pinned release asset (GitHub releases, ${GITHUB_RELEASE_COOLDOWN_DAYS}-day release cooldown)`,

  files: async () => (await pinnedDeps()).map((p) => p.pinFile),

  detect: (root) => rows(root, "honour"),

  async plan(root, { only, cooldown }): Promise<UpdaterPlan> {
    const outdated = await rows(root, cooldown);
    if (only !== undefined) {
      const known = new Set((await pinnedDeps()).map((p) => p.id));
      const unknown = only.filter((n) => !known.has(n));
      if (unknown.length > 0) {
        throw new Error(
          `No github-release pin named ${unknown.join(", ")}. Pinned: ${[...known].join(", ") || "none"}.`,
        );
      }
    }
    const selected = outdated.filter(
      (o) => only === undefined || only.includes(o.name),
    );
    return {
      moves: selected
        .filter((o) => o.waiting === undefined)
        .map((o): Move => ({ name: o.name, from: o.current, to: o.latest })),
      outdated: selected,
    };
  },

  async apply(root, moves, log) {
    const pins = new Map((await pinnedDeps()).map((p) => [p.id, p.pinFile]));
    for (const m of moves) {
      const pinFile = pins.get(m.name);
      if (pinFile === undefined) {
        throw new Error(`github-release move ${m.name} names no declared pin`);
      }
      const pin = await readPin(root, pinFile);
      if (pin.tag !== m.from) {
        throw new Error(
          `${pinFile} pins ${pin.tag}, but the move of ${m.name} is from ${m.from ?? "nothing"}`,
        );
      }
      const release = toRelease(
        releaseSchema.parse(
          await github(
            `/repos/${pin.repo}/releases/tags/${encodeURIComponent(m.to)}`,
          ),
        ),
      );
      if (release === null) {
        throw new Error(`${pin.repo} ${m.to} is a draft or a pre-release`);
      }
      const next = movedPin(pin, release);
      log(`  ${m.name}: ${pin.tag} → ${next.tag} (${pinFile})`);
      await writeFile(
        joinAppPath(root, pinFile),
        `${JSON.stringify(next, null, 2)}\n`,
      );
    }
  },

  // Nothing to undo: `apply` only rewrites pin files, and each pin is an
  // identity of its own in the deps cache.
  sync: async () => {},

  // A moved pin must still install: the download, its digest and the
  // declaration's derive step.
  smoke: async (_root, moves) =>
    moves.map((m) => ({
      name: `deps install ${m.name}`,
      argv: [`./${CLI_NAME}`, "deps", "install", m.name],
      timeoutMs: 30 * MINUTE,
    })),

  holds: {
    file: GITHUB_RELEASE_HOLDS_FILE,
    read: async () => GITHUB_RELEASE_HOLDS,
  },
};
