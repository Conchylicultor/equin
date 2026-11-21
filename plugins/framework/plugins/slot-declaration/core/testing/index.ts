/**
 * Test support for the slot-declaration engine. Every slot this runtime has
 * constructed, for a test asserting something of all of them (that each one's
 * site was tracked). Production code reads one declaration pass's own naming
 * (`SlotNaming.declarations()`), never this process-wide set: its order is
 * module-evaluation order, a function of whatever else the process loaded.
 */
export { getCreatedSlots } from "../declaration";
