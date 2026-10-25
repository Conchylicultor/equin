export type ParsedCombo = {
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
};

export type ShortcutDescriptor = {
  id: string;
  keys: string;
  label: string;
  group?: string;
  handler: () => void;
  /**
   * Eligibility gate, evaluated on the keystroke that matched. The event is
   * passed so a shortcut can decide from WHERE the key landed (`event.target`)
   * — e.g. undo yielding to a text field that keeps its own history. Most
   * guards ignore it and read their own state.
   */
  when?: (event: KeyboardEvent) => boolean;
  /**
   * Which handler wins when several eligible shortcuts match ONE keystroke
   * (`Escape` while a tour, edit mode and solo are all live): the highest
   * precedence fires, alone. Default 0. Not an order of anything drawn.
   */
  precedence?: number;
  /**
   * Fire even when an editable element (input/textarea/select/contenteditable)
   * is focused. Off by default: plain-key shortcuts yield to the text field so
   * the keystroke is typed. Modifier combos (Cmd/Ctrl/Alt+…) always fire
   * regardless of this flag. Set true only for a plain-key shortcut that must
   * win inside inputs.
   */
  enableInInputs?: boolean;
  /**
   * If set, this shortcut is eligible only when its surface is the focused
   * surface; unset = global, always eligible.
   */
  surfaceId?: string;
};
