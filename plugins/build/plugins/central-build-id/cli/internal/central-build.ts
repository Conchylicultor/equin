import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sourceDigest } from "@plugins/packages/plugins/source-digest/server";
import { realpath } from "@plugins/packages/plugins/timed-fs/core";
import { CENTRAL_ENTRY } from "../../core";
import { centralCodeSet } from "../../shared/central-code-set";

/**
 * Central's code build as the checkout at `root` holds it — the digest central
 * computes over the same entry when it runs this code. `./equin build` bakes it
 * into the page beside the web graph, so a tab names the central build its
 * bundle was built against. Throws when the closure cannot be digested (a
 * computed-path import, an unresolvable one — `boot:closure-digestable` keeps
 * central's closure free of both): a build that cannot name it fails loudly.
 */
export async function centralBuildOf(root: string): Promise<string> {
  const entry = await realpath(join(root, CENTRAL_ENTRY));
  return sourceDigest([centralCodeSet(pathToFileURL(entry).href)]);
}
