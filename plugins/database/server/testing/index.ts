// The real snapshot watermark capture (`snapshotWatermark`), for a suite that
// builds its own resource runtime over a throwaway database and must stamp
// frames — or floor persists — exactly as the served runtime does, rather than
// restating the SQL. Shipping code never calls it: the runtime reads it through
// server-core's `setWatermarkSource`, which this plugin's `onReadyBlocking`
// installs.
export { snapshotWatermark } from "../internal/snapshot-watermark";
