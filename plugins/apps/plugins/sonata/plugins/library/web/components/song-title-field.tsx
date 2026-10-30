import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useEditableField } from "@plugins/primitives/plugins/editable-field/web";
import {
  cn,
  Input,
  useControlSize,
  type ControlSize,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { updateSong, type Song } from "../../core";
import { useCurrentSong } from "../use-current-song";

/**
 * The title shimmer's height at the ambient toolbar density, so the placeholder
 * is exactly as tall as the `Input` that replaces it (which reads the density
 * itself). Spelled out per density because Tailwind only emits class names it
 * can see as literals (a `control-${size}` template would compile to nothing).
 */
const CONTROL_HEIGHT: Record<ControlSize, string> = {
  xs: "control-xs",
  sm: "control-sm",
  md: "control-md",
  lg: "control-lg",
};

/**
 * The player pane's inline-editable song title — its `title.component`
 * (`Pane.define({ title: { component: SongTitle } })`), not a header
 * contribution: a pane already contributes exactly one `title` item into its
 * own header, and this is what that item paints. The song title has exactly ONE client-side owner — the library's
 * `songLibrary` collection — so this reads the canonical row via `useCurrentSong()` and
 * patches it through `PATCH /api/sonata/songs/:id`. There is no shell-context
 * mirror to seed from, and no source editor writes the title anymore.
 *
 * The loading arm (its shimmer) and the error arm (the failure, with Retry) gate
 * the mount so `useEditableField` is only ever seeded from a *ready* title (the sanctioned "never autosave from a not-yet-loaded value"
 * guard, mirroring `PageHeader`). Renders nothing until a song row exists.
 */
export function SongTitle({
  appearance = "field",
}: {
  /**
   * `field` (default) — an input at the ambient control density, for a pane
   * header row. `heading` — the immersive player's title: the subheading role
   * in bold, no box at rest, as tall as its text.
   */
  appearance?: "field" | "heading";
} = {}) {
  const size = useControlSize();
  const current = useCurrentSong();
  switch (current.status) {
    case "loading":
      // A title-shaped shimmer, not the word "Loading…" — this slot IS the
      // header. `Loading` only fades in after ~120ms, so a warm row never
      // flashes it.
      return (
        <Loading variant="block" className={cn(CONTROL_HEIGHT[size], "w-56")} />
      );
    case "error":
      // A failed read says why — never a shimmer that waits forever.
      return (
        <ResourceErrorInline
          error={current.error}
          refetch={current.refetch}
          variant="inline"
        />
      );
    case "ready":
      return current.found ? (
        <SongTitleInner song={current.row} appearance={appearance} />
      ) : null;
  }
}

function SongTitleInner({
  song,
  appearance,
}: {
  song: Song;
  appearance: "field" | "heading";
}) {
  const { mutateAsync } = useEndpointMutation(updateSong);

  const title = useEditableField({
    value: song.title,
    label: "Song title",
    onSave: async (next) => {
      const trimmed = next.trim();
      // An empty title is not a rename — skip the write. The user can still
      // clear the input while typing; re-mounting re-seeds from the canonical
      // value, so the row is never left blank.
      if (!trimmed) return;
      await mutateAsync({ params: { id: song.id }, body: { title: trimmed } });
    },
  });

  // Reads as plain text until hovered/focused — the title IS the header, so the
  // input chrome only appears when it is being treated as one.
  return (
    <Input
      value={title.value}
      onChange={(e) => title.onChange(e.target.value)}
      onFocus={title.onFocus}
      onBlur={title.onBlur}
      placeholder="Untitled"
      aria-label="Song title"
      className={
        appearance === "heading"
          ? "h-auto w-80 rounded-sm border-transparent bg-transparent px-2xs py-none text-subheading font-bold hover:border-border focus:border-primary"
          : "w-56 border-transparent bg-transparent font-semibold hover:border-border focus:border-primary"
      }
    />
  );
}
