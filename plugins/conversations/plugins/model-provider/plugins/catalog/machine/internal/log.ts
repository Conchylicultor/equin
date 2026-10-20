import { Log } from "@plugins/primitives/plugins/log-channels/server";

/** The catalog's one log channel (a channel name may be declared only once). */
export const catalogLog = Log.channel("model-catalog");
