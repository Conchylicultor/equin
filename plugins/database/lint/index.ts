import noPoolAwaitInTransaction from "./no-pool-await-in-transaction";
import noPureWriteTransaction from "./no-pure-write-transaction";

export default {
  name: "database",
  rules: {
    "no-pool-await-in-transaction": noPoolAwaitInTransaction,
    "no-pure-write-transaction": noPureWriteTransaction,
  },
};
