import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import type { Server } from "../../shared";
import { ServerDetail, type ServerDetailColumn } from "../slots";
import { ServerHeaderBar } from "./server-header";

/**
 * A registered server's page: the header, then the contributed sections in two
 * columns — `main` (wide) and `side` (a fixed rail of facts). Each column is a
 * `SectionStack` of `SectionItem`s, so the chrome and rhythm are still the
 * primitive's; only the split is this page's.
 */
export function ServerPage({ server }: { server: Server }) {
  return (
    // The site page's measure (centred, capped), so moving between a site and
    // its server does not shift the page; the section stacks bring their own
    // inline padding, so the header matches it rather than the site's.
    <Stack gap="none" className="mx-auto w-full max-w-[1180px] px-md pb-2xl">
      <ServerHeaderBar server={server} />
      <Stack direction="row" align="start" gap="none">
        <Fill>{column("main", server)}</Fill>
        {/* 340px cards, as the site Overview's rail: the column adds the
            section stack's inline padding around them. */}
        <Rigid className="w-[372px] max-w-full">{column("side", server)}</Rigid>
      </Stack>
    </Stack>
  );
}

function column(which: ServerDetailColumn, server: Server) {
  return (
    <ServerDetail.SectionStack>
      <ServerDetail.Section.Render subId={which}>
        {(s) =>
          s.column === which ? (
            <ServerDetail.SectionItem section={s} entityProps={{ server }} />
          ) : null
        }
      </ServerDetail.Section.Render>
    </ServerDetail.SectionStack>
  );
}
