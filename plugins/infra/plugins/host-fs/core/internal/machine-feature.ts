/**
 * What every read of this machine's disk needs — a live value or an endpoint,
 * its `needsMachine` — so a sibling read (an image sub-plugin's) states the
 * same feature, and every reader in one viewer shows the same unavailable
 * message.
 */
export const HOST_FS_MACHINE = {
  feature: "Browsing this computer's files",
} as const;
