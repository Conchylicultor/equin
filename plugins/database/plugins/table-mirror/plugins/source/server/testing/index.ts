// The source half's install and prune, for another plugin's test that needs a
// source to read from (the replica's suite runs both halves in one database);
// in production the plugin's own boot and job run them.
export { installMirrorSource } from "../internal/install";
export { pruneMirrorLog } from "../internal/prune";
