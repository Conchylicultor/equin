import { HostRefusedError } from "@plugins/framework/plugins/browser-server/core";

/**
 * The stored data was written by newer code than this worker's: its
 * migrations include one this code does not know. Booting would run old code
 * over the new schema, so the host refuses, and the tab asks for a reload.
 */
export class StorageNewerThanCodeError extends HostRefusedError {
  constructor(message: string) {
    super(message);
    this.name = "StorageNewerThanCodeError";
  }
}
