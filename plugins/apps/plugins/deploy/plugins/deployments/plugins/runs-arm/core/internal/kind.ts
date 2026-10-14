/**
 * This arm's discriminator value.
 *
 * Spelled once because it is load-bearing in two places that must agree: the
 * kind of its `liveArm` (every wire name's and row key's prefix), and
 * the `run.kind` guard every field accessor makes before decoding a row as one
 * of this arm's.
 */
export const DEPLOY_RUN_KIND = "deploy";
