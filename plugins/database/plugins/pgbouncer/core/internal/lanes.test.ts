import { describe, expect, it } from "bun:test";
import {
  assertLaneBudget,
  DIRECT_SESSION_RESERVE,
  laneUser,
  PGBOUNCER_LANES,
  renderPgbouncerConfig,
  type PgbouncerConfigInputs,
  type PgbouncerLane,
} from "./lanes";

const LANES = Object.keys(PGBOUNCER_LANES) as PgbouncerLane[];

const INPUTS: PgbouncerConfigInputs = {
  baseUser: "equin",
  socketDir: "/tmp/socket",
  pgPort: 5433,
  listenPort: 6432,
  userlistFile: "/tmp/userlist.txt",
  logFile: "/tmp/pgbouncer.log",
  pidFile: "/tmp/pgbouncer.pid",
  maxConnections: 500,
};

describe("PgBouncer lanes", () => {
  it("gives every lane its own login role", () => {
    const users = LANES.map((lane) => laneUser("equin", lane));
    expect(new Set(users).size).toBe(LANES.length);
    expect(laneUser("equin", "interactive")).toBe("equin");
  });

  it("renders each lane's pool size and cluster cap, and lets only lane users log in", () => {
    const { ini, userlist } = renderPgbouncerConfig(INPUTS);
    for (const lane of LANES) {
      const { poolSize, clusterCap } = PGBOUNCER_LANES[lane];
      expect(ini).toContain(
        `${laneUser("equin", lane)} = pool_size=${poolSize} max_user_connections=${clusterCap}`,
      );
    }
    expect(userlist.trim().split("\n")).toEqual(
      LANES.map((lane) => `"${laneUser("equin", lane)}" ""`),
    );
    // No shared default pool a lane could fall back into.
    expect(ini).not.toContain("default_pool_size");
  });

  it("keeps the lanes' cluster caps and the direct sessions inside max_connections", () => {
    expect(() => assertLaneBudget(500)).not.toThrow();
    const caps = LANES.reduce(
      (n, lane) => n + PGBOUNCER_LANES[lane].clusterCap,
      0,
    );
    expect(() => assertLaneBudget(caps + DIRECT_SESSION_RESERVE)).toThrow(
      /lane budget/,
    );
  });
});
