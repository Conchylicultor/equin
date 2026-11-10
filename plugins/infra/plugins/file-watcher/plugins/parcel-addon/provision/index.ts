import { linkAddonAfterInstall } from "./internal/link-addon";

// Runs after every `bun install` (the root postinstall's provision registry).
export default linkAddonAfterInstall;
