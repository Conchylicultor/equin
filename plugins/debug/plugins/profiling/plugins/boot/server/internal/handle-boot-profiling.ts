import { implement } from "@plugins/infra/plugins/endpoints/server";
import { getBootProfiling } from "../../core";
import { readBootProfile } from "./boot-profile";

// Kept for the cold-start e2e (`debug/profiling/cold-start/e2e/cold-start.ts`),
// which reads the profile over plain HTTP; the pane reads `profiling.boot`.
export const handleBootProfiling = implement(getBootProfiling, readBootProfile);
