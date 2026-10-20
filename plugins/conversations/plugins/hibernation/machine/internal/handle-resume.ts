import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { ensureResumed } from "@plugins/conversations/server";
import { resumeHibernated } from "../../shared/endpoints";

// Transparently resume the conversation if it was hibernated (no-op otherwise).
//
// `ensureResumed`'s outcome is returned verbatim, including its `blocked` arm.
// A conversation that cannot be resumed keeps its status and its hibernation
// flag — the user's list is unchanged and the client renders the reason.
export const handleResume = implementMachine(resumeHibernated, ({ params }) =>
  ensureResumed(params.id),
);
