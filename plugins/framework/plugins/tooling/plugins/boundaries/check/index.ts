import { boundaryRulesCheck } from "../core";
import { portableClosureCheck } from "./portable-closure";
import { portableOwnBarrelsCheck } from "./portable-own-barrels";

export default [
  boundaryRulesCheck,
  portableClosureCheck,
  portableOwnBarrelsCheck,
];
