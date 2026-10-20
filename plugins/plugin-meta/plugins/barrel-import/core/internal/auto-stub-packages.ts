export interface AutoStubEntry {
  pkg: string;
  resolveFrom?: string;
}

export const AUTO_STUB_PACKAGES: AutoStubEntry[] = [
  { pkg: "@dnd-kit/core" },
  { pkg: "@dnd-kit/sortable" },
  { pkg: "@dnd-kit/utilities" },
  { pkg: "react-diff-view" },
  { pkg: "react-resizable-panels" },
  // Charts only render; metadata extraction never does. Imported for real it is
  // ~1 s of module evaluation on the check runner's shared thread.
  { pkg: "recharts", resolveFrom: "plugins/stats" },
];

export const AUTO_STUB_CSS: string[] = ["react-diff-view/style/index.css"];
