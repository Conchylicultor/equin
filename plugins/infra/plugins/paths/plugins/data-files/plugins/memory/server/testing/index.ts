// A fresh, private memory provider for another plugin's suite — the same
// store a browser host boots, without the process-wide one the barrel provides.
export { createMemoryDataFiles } from "../internal/memory-store";
