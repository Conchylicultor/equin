import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

/** What a gate is asked about: the run about to start, by its ledger facts. */
export interface DeployGateSubject {
  readonly deploymentId: string;
  readonly compositionId: string;
}

/**
 * A gate's answer. `needs-approval` carries the sentence the run ends with and
 * WHERE it is resolved — `resolveIn`, the id of the site Settings tab's
 * `DeploymentDetail` section the user approves in — because the gate is the
 * only party that knows either. The id is persisted on the run
 * (`approvalSections`), so every surface showing the held run links there
 * without reading its message.
 */
export type DeployGateVerdict =
  | { readonly kind: "pass" }
  | {
      readonly kind: "needs-approval";
      readonly message: string;
      readonly resolveIn: string;
    };

/** Every gate's answer joined: one message, and each section to resolve it in. */
export type DeployGatesVerdict =
  | { readonly kind: "pass" }
  | {
      readonly kind: "needs-approval";
      readonly message: string;
      readonly resolveIn: readonly string[];
    };

/**
 * One thing a deploy must not do without the user's explicit say-so.
 *
 * Asked once per run, BEFORE any leg is spawned: a run any gate refuses ends
 * `needs-approval`, having converged and shipped nothing. A gate that throws
 * fails the run (it could not decide, so nothing goes out on a guess).
 */
export interface DeployGate {
  /** Stable id, named in the log line a refusal writes. */
  readonly id: string;
  readonly check: (subject: DeployGateSubject) => Promise<DeployGateVerdict>;
}

/**
 * The deploy gates. The run sequencer asks every one and names none: a plugin
 * that wants the user to sign off on something a deploy carries (a deploy
 * secret, say) contributes `DeployGates.Gate` and nothing else.
 */
export const DeployGates = {
  Gate: defineServerContribution<DeployGate>("deploy.gate", {
    docLabel: (g) => g.id,
  }),
};

/**
 * Ask every gate. The verdicts are joined, so a run blocked by two gates says
 * both things at once instead of making the user clear them one deploy at a
 * time.
 */
export async function checkDeployGates(
  subject: DeployGateSubject,
  gates: readonly DeployGate[],
): Promise<DeployGatesVerdict> {
  const verdicts = await Promise.all(gates.map((g) => g.check(subject)));
  const blocked = verdicts.flatMap((v) =>
    v.kind === "needs-approval" ? [v] : [],
  );
  return blocked.length === 0
    ? { kind: "pass" }
    : {
        kind: "needs-approval",
        message: blocked.map((v) => v.message).join("\n\n"),
        resolveIn: [...new Set(blocked.map((v) => v.resolveIn))],
      };
}
