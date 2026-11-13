// A throwaway git repo a check's input-keyed read-set is recorded and
// revalidated against, the way the check runner drives it.
export { createReadSetRepo, type ReadSetRepo } from "./read-set-repo";
// The repo's file set as a plain sorted array, for a test that builds a
// fixture repo and runs a check's selection over it (a check reads ctx.repo()).
export { listRepoFiles } from "../repo-files";
