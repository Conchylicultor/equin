import { fileHint } from "../file-hint";

export const packageJsonHint = fileHint({
  name: "package-json-singularity-ns",
  match: (p) => p.endsWith("/package.json"),
  message:
    'Reminder: Singularity metadata goes under the "singularity" key, not at the root level. Exception: "description" is a standard npm field and belongs at the root.',
});
