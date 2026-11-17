/**
 * Checks contributed by the installer: the two places the install's progress
 * view could silently lose a fact — a build sub-step no span declares any
 * more, and install.sh's estimate table drifting from the measured one.
 */
import buildSubStepsDeclared from "./build-sub-steps-declared";
import estimatesInSync from "./estimates-in-sync";

export default [buildSubStepsDeclared, estimatesInSync];
