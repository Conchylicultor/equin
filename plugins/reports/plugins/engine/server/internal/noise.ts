import {
  ReportNoiseRule,
  type ReportNoiseInput,
} from "@plugins/reports/server";
import { matchesAnyRule } from "./noise-input";

// collectContributions() runs at boot, before any handler — getContributions() is populated
// by the time recordReport runs (HTTP handler, onReady flush, or error reporter).
export function isNoiseReport(input: ReportNoiseInput): boolean {
  return matchesAnyRule(ReportNoiseRule.getContributions(), input);
}
