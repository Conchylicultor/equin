import type { ServeStatus } from "@plugins/build/plugins/serve-composition/web";

type ReadyStatus = Extract<ServeStatus, { kind: "ready" }>;

/**
 * What Test locally does for a composition whose serve state is known.
 *
 * Test locally is the rehearsal of Deploy, so it may only OPEN a build of the
 * commit Deploy would ship — this checkout's HEAD. A served build a push has
 * since left behind is not that rehearsal: opening it would show an old
 * version beside a Deploy button that ships a newer one. So the button opens
 * only a CURRENT serve, and builds in every other case (nothing served, or
 * served from another commit). While a build of it is in flight it does
 * neither: it says Building…, since opening would show the old version and
 * another click would only be dropped by the one-build-per-checkout claim.
 */
export type TestLocally =
  | { kind: "building"; tooltip: string }
  | { kind: "open"; url: string; tooltip: string }
  | { kind: "build"; tooltip: string };

const short = (sha: string): string => sha.slice(0, 7);

export function testLocally(name: string, status: ReadyStatus): TestLocally {
  const { live, url, head } = status;
  if (status.building) {
    return {
      kind: "building",
      tooltip: `Building ${name} from ${short(head)} — it opens here at ${url} once served`,
    };
  }
  if (live.served && live.current) {
    return {
      kind: "open",
      url,
      tooltip: `Open ${url} — built from ${short(head)}, what Deploy would ship`,
    };
  }
  if (live.served) {
    return {
      kind: "build",
      tooltip:
        live.commit === null
          ? `The build served at ${url} recorded no commit — rebuild ${name} from ${short(head)} and serve it`
          : `The build served at ${url} is from ${short(live.commit)}, not ${short(head)} — rebuild ${name} and serve it`,
    };
  }
  return {
    kind: "build",
    tooltip: `Build ${name} from ${short(head)} and serve it at ${url}`,
  };
}
