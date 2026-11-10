// Shared CLI machinery, not a command (no default export): the deployment
// description as a process outside any backend reads it.
export { readServedDeployment } from "./internal/served-deployment";
