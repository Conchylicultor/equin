import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  checkoutNamespace,
  checkoutRef,
} from "@plugins/infra/plugins/paths/core";
import {
  namespaceFor,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import { callEndpoint } from "@plugins/infra/plugins/endpoints/server";
import { closeAdminPool } from "@plugins/database/plugins/admin/server";
import { resetServedComposition } from "@plugins/build/plugins/serve-composition/server";
import { ensureChordIndexEndpoint } from "@plugins/apps/plugins/chord/plugins/song-index/core";
import { markHintSeenEndpoint } from "@plugins/hints/core";
import {
  FILM_SEEN_HINTS,
  PROMO_FILM_COMPOSITION_ID,
  seedPromoFilm,
} from "@plugins/apps/plugins/website/plugins/promo-film/plugins/seed/core";

/**
 * 1. Reset the checkout's `promo-film` namespace to first launch — the serve
 *    capability's own reset (its guards refuse main, a namespace no serve build
 *    owns, and a composition whose serve mode is off): its database dropped and
 *    created empty, its config re-propagated, its backend restarted.
 * 2. Ask that backend (booted afresh, migrations applied) to seed itself.
 * 3. Mark the onboarding tips the film's user has already met
 *    (`FILM_SEEN_HINTS`), through the hints engine's own write.
 * 4. Open the Chord song index there, as the app does on first use, so the
 *    trainer is ready when the film reaches it.
 */
const run: CliAction<[], Record<string, never>> = async () => {
  const root = await getWorktreeRoot();
  const namespace = namespaceFor(
    PROMO_FILM_COMPOSITION_ID,
    await checkoutRef(root),
  );
  const origin = namespaceUrl(namespace);
  console.log(`Resetting ${namespace} to first launch…`);
  try {
    await resetServedComposition(
      PROMO_FILM_COMPOSITION_ID,
      await checkoutNamespace(root),
    );
  } finally {
    await closeAdminPool();
  }
  console.log(`Seeding ${origin} …`);
  const report = await callEndpoint(seedPromoFilm, {}, { origin });
  for (const { step, wrote } of report.steps)
    console.log(`  ${step.padEnd(11)} ${wrote}`);
  for (const hint of FILM_SEEN_HINTS)
    await callEndpoint(markHintSeenEndpoint, {}, { origin, body: hint });
  console.log(
    `  ${"hints".padEnd(11)} ${FILM_SEEN_HINTS.length} tips already met`,
  );
  const chord = await callEndpoint(ensureChordIndexEndpoint, {}, { origin });
  console.log(`  ${"chord".padEnd(11)} song index: ${JSON.stringify(chord)}`);
  console.log(`\nReady: ${origin}`);
};

export default run;
