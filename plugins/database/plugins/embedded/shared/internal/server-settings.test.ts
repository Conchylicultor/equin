import { describe, expect, it } from "bun:test";
import { clusterServerSettings, sharedBuffersBytes } from "./server-settings";

const GB = 1024 ** 3;

describe("sharedBuffersBytes", () => {
  it("is 1/16 of RAM, in whole MB, between 128 MB and 1 GB", () => {
    expect(sharedBuffersBytes(64 * GB)).toBe(1 * GB);
    expect(sharedBuffersBytes(16 * GB)).toBe(1 * GB);
    expect(sharedBuffersBytes(8 * GB)).toBe(512 * 1024 ** 2);
    expect(sharedBuffersBytes(1 * GB)).toBe(128 * 1024 ** 2);
    expect(sharedBuffersBytes(8 * GB + 12345) % 1024 ** 2).toBe(0);
  });
});

describe("clusterServerSettings", () => {
  it("spells shared_buffers in MB, as Postgres reads it on the command line", () => {
    expect(clusterServerSettings(64 * GB)).toEqual({
      max_connections: "500",
      shared_buffers: "1024MB",
    });
  });
});
