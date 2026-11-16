import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  BUILD_FAILED_KIND,
  BuildFailedPayloadSchema,
  buildFailureSignature,
  type BuildFailedPayload,
} from "../../core";
import { renderBuildFailedTask } from "./render";

/**
 * The `build-failed` report kind: one row per WAY main's build fails (see
 * `buildFailureSignature`), filed by main's backend when a build of main ends
 * `failed` — never superseded, killed or interrupted, which say nothing about
 * the code. Category `error`, so the Error reports supervisor stream carries
 * it; its owning task is the build's own Investigate task (`linkRunReport`).
 */
export const buildFailedKind = ReportKind({
  kind: BUILD_FAILED_KIND,
  schema: BuildFailedPayloadSchema,
  fingerprint: (d: BuildFailedPayload) =>
    `${BUILD_FAILED_KIND}:${buildFailureSignature(d)}`,
  meta: {
    tag: "[build-failed]",
    notif: "Main's build failed",
    variant: "error",
    category: "error",
  },
  renderTask: (row: ReportRow) =>
    renderBuildFailedTask(row, BuildFailedPayloadSchema.parse(row.data)),
});
