// The category Improve submissions are stamped with. The server contributes the
// matching TaskCategory registration; it lives in `core/` (not `shared/`, which
// is plugin-private) because other plugins file tasks under it too — a renderer
// request from the JSONL viewer is a wish too.
export const WISHES_CATEGORY_ID = "wishes";
