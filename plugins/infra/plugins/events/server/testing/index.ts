// Detaches the stored event subscriptions from a test's transaction, for a
// suite driving a real database whose trigger rows bind jobs its process never
// registered.
export { detachStoredTriggers } from "./detach-stored-triggers";
