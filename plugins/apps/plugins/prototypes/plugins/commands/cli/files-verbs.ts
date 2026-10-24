// The five verb bodies `files` keeps, behind one module of this plugin's own
// so the declaration can load them with a relative dynamic `import(…)` — a
// cross-plugin one would hide the edge from the boundary checker (R9).
export {
  checkpointPrototypeAction,
  newPrototypeAction,
  prototypeLogAction,
  prototypeOptionsAction,
  restorePrototypeAction,
} from "@plugins/apps/plugins/prototypes/plugins/files/cli";
