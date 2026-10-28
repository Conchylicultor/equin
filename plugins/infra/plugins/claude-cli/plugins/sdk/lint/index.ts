import noClaudeBinSpawn from "./no-claude-bin-spawn";
import noDirectSdkQuery from "./no-direct-sdk-query";

export default {
  name: "claude-sdk",
  rules: {
    "no-claude-bin-spawn": noClaudeBinSpawn,
    "no-direct-sdk-query": noDirectSdkQuery,
  },
};
