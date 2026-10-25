import type { Dispatch, SetStateAction } from "react";
import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import {
  DEFAULT_DRAFT_TTL,
  useDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";

/** The panel's one text field, while it is typed (one entry). */
const panelInputStore = defineStore<string>({
  owner: "menu-bar.input",
  label: "Menu-bar panel text",
  area: "local",
  cap: "64 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "refuse",
  schema: z.string(),
});

/**
 * What the user is typing in the panel: the task field's text, which every
 * section may read (the app grid filters its tiles by it). A draft, so it
 * survives the page reloading under it — the panel reloads itself while hidden
 * when main ships new web — and the helper restarting.
 */
export function usePanelInput(): [string, Dispatch<SetStateAction<string>>] {
  const [text, setText] = useDraft(panelInputStore, "");
  return [text, setText];
}
