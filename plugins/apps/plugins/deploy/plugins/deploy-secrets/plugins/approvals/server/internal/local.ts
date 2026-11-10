import {
  DeploySecrets,
  type DeploySecretLocalValue,
} from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/server";
import { fingerprintSecret } from "./fingerprint";
import { checkLocalValue, previewLocalValue, type LocalReading } from "./plan";

/**
 * The `DeploySecrets.LocalValue` contribution naming `key`, or `undefined`
 * when no plugin says where this computer keeps it. Two for one key is a
 * conflict nobody could resolve from the UI, so it throws.
 */
export function localValueSource(
  key: string,
): DeploySecretLocalValue | undefined {
  const matches = DeploySecrets.LocalValue.getContributions().filter(
    (c) => c.secret.key === key,
  );
  if (matches.length > 1) {
    throw new Error(
      `[deploy-secrets] ${matches.length} DeploySecrets.LocalValue contributions name ${key}; one key has one local counterpart.`,
    );
  }
  return matches[0];
}

/**
 * This computer's value of `key`, read now: the value itself (server memory
 * only — stored by Use, never put on a row) and the reading a row shows.
 * `undefined` when nothing names it or it has no value.
 */
export async function readLocalValue(
  hmacKey: CryptoKey,
  key: string,
): Promise<{ value: string; reading: LocalReading } | undefined> {
  const source = localValueSource(key);
  if (source === undefined) return undefined;
  const read = await source.read();
  if (read.kind === "unset" || read.value === "") return undefined;
  const checked = checkLocalValue(read.value);
  if (!checked.ok) {
    return {
      value: read.value,
      reading: { kind: "unusable", reason: checked.reason },
    };
  }
  return {
    value: read.value,
    reading: {
      kind: "set",
      preview: previewLocalValue(read.value, source.reveal),
      fingerprint: await fingerprintSecret(hmacKey, key, read.value),
      caution: source.caution ?? null,
    },
  };
}

/**
 * Follow every local counterpart while a tab reads the Secrets rows, so a
 * value changed on this computer re-renders its preview — each source's own
 * change signal, never a poll.
 */
export async function watchLocalValues(
  changed: () => void,
): Promise<() => void> {
  const started = await Promise.allSettled(
    DeploySecrets.LocalValue.getContributions().map((c) => c.watch(changed)),
  );
  const stops = started.flatMap((s) =>
    s.status === "fulfilled" ? [s.value] : [],
  );
  const failed = started.find((s) => s.status === "rejected");
  // One source that cannot be watched fails the subscription — after the
  // ones that did start are stopped, so nothing is left watching.
  if (failed !== undefined) {
    for (const stop of stops) stop();
    throw failed.reason;
  }
  return () => {
    for (const stop of stops) stop();
  };
}
