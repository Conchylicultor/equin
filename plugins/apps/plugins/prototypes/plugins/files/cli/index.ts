// The bodies of `./equin prototype`'s verbs. A `cli/` barrel with no default
// export, so not a command: the `prototype` group is declared by
// `apps/prototypes/commands`, the plugin above both this one and `state` —
// `list` needs `state`'s deleted marks, which this plugin cannot import
// (`state` imports it). `list` takes them as data (`printPrototypeList`).
export { newPrototypeAction } from "./new";
export { prototypeOptionsAction } from "./options";
export { prototypeLogAction } from "./log";
export { checkpointPrototypeAction } from "./checkpoint";
export { restorePrototypeAction } from "./restore";
export { printPrototypeList } from "./list";
export type { DeletedPrototypeIds } from "./list";
