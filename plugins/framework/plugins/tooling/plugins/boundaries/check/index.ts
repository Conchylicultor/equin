import { boundaryRulesCheck } from "../core";
import { machinePortableDeclarationCheck } from "./machine-portable-declaration";
import { portableOwnBarrelsCheck } from "./portable-own-barrels";

export default [
  boundaryRulesCheck,
  portableOwnBarrelsCheck,
  machinePortableDeclarationCheck,
];
