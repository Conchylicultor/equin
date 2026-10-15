import { serveCollection } from "@plugins/network/plugins/live/server";
import { swings } from "../../shared/resources";
import { songSwing } from "./tables";

// Server half of the per-song swing read: the lookup-only collection served
// from the extension entity.
export const swingsServed = serveCollection(swings, { from: songSwing });
