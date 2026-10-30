import { boundaryRulesCheck } from "../core";
import { machinePortableDeclarationCheck } from "./machine-portable-declaration";
import { portableClosureCheck } from "./portable-closure";
import { portableOwnBarrelsCheck } from "./portable-own-barrels";

export default [
  boundaryRulesCheck,
  portableClosureCheck,
  portableOwnBarrelsCheck,
  machinePortableDeclarationCheck,
];
