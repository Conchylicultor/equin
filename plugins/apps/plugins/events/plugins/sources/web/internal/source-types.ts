import { EventSources } from "@plugins/apps/plugins/events/plugins/events-core/web";

/**
 * One registered source type, as the slot hands it back. Derived from the slot
 * rather than re-spelled, so this file cannot drift from `events-core`'s
 * contribution shape (and picks up the loader-injected metadata for free).
 */
export type EventSourceTypeContribution = ReturnType<
  typeof EventSources.Type.useContributions
>[number];

/**
 * Whether a source row's `type` still resolves to an installed source type.
 *
 * A union, not `Contribution | undefined`: a row whose type plugin has been
 * uninstalled is a real, renderable state ("this source's type is not
 * installed") that a surface must say out loud — the alternative is a settings
 * form that silently renders nothing and reads as "no configuration".
 */
export type SourceTypeLookup =
  | { status: "registered"; type: EventSourceTypeContribution }
  | { status: "unregistered" };

/** Every installed source type, in contributed order. */
export function useEventSourceTypes(): readonly EventSourceTypeContribution[] {
  return EventSources.Type.useContributions();
}

/** Resolve one source row's `type` id against the registry. */
export function useEventSourceType(typeId: string): SourceTypeLookup {
  const types = EventSources.Type.useContributions();
  const type = types.find((t) => t.id === typeId);
  return type ? { status: "registered", type } : { status: "unregistered" };
}
