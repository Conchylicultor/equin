import { HostRefusedError } from "@plugins/framework/plugins/browser-server/core";

/**
 * The storage belongs to newer code than this worker's: its stored data was
 * migrated (or seeded) by a newer build, or a newer build's worker holds it.
 * Booting would run old code over the new schema, so the host refuses
 * (`{ kind: "outdated" }`), and the tab asks for a reload — which loads the
 * newer build.
 */
export class StorageNewerThanCodeError extends HostRefusedError {
  constructor(detail: string) {
    super({ kind: "outdated" }, detail);
    this.name = "StorageNewerThanCodeError";
  }
}
