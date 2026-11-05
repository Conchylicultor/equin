import { prototypesFiles } from "@plugins/apps/plugins/prototypes/server";
import { PrototypeRecords } from "./records";

/**
 * The server's records of the prototypes tree (`records.ts`), over the app's
 * file root — moved by the watcher (`watcher.ts`), read by the list.
 */
export const prototypeRecords = new PrototypeRecords(prototypesFiles);
