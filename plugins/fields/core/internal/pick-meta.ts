import type { FieldMeta } from "./types";

// The presentation meta a field factory keeps from its options. A key the
// caller did not pass stays absent (`primary`, `filterable`, `optionMeta`), so a
// field declared without them carries exactly the meta it always did.
export function pickMeta(opts?: FieldMeta): FieldMeta {
  return {
    label: opts?.label,
    description: opts?.description,
    placeholder: opts?.placeholder,
    ...(opts?.primary !== undefined ? { primary: opts.primary } : {}),
    ...(opts?.filterable !== undefined ? { filterable: opts.filterable } : {}),
    ...(opts?.optionMeta !== undefined
      ? { optionMeta: Object.freeze({ ...opts.optionMeta }) }
      : {}),
  };
}
