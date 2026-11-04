import { test, expect } from "bun:test";
import { capSignature } from "./cap-signature";

const CAP = 256;

function deep(leafIndex: number): string {
  const owner =
    "plugins/apps/plugins/agent-manager/plugins/some/very/long/owner/path/component.tsx:123";
  const path = [
    "div:nth-of-type(1)",
    "div:nth-of-type(2)",
    "section:nth-of-type(1)",
    `div:nth-of-type(${leafIndex})`,
  ].join(">");
  return [
    "conversations/transcript@Transcript.Block",
    "plugins/conversations/plugins/transcript/web/components/block-renderer.tsx:42",
    owner,
    "pane:conv-1793795009-abcdef",
    path,
  ].join(" | ");
}

test("short signatures pass through unchanged", () => {
  expect(capSignature("a@b |  |  |  | div:nth-of-type(1)", CAP)).toBe(
    "a@b |  |  |  | div:nth-of-type(1)",
  );
});

test("long signatures differing only in the tail stay distinct and bounded", () => {
  const a = capSignature(deep(3), CAP);
  const b = capSignature(deep(4), CAP);
  expect(deep(3).length).toBeGreaterThan(CAP);
  expect(a).not.toBe(b);
  expect(a.length).toBeLessThanOrEqual(CAP);
  expect(b.length).toBeLessThanOrEqual(CAP);
});

test("keeps the plugin head and the leaf-most path segments whole", () => {
  const s = capSignature(deep(7), CAP);
  expect(s.startsWith("conversations/transcript@Transcript.Block | ")).toBe(
    true,
  );
  expect(s.endsWith(">div:nth-of-type(7)")).toBe(true);
  expect(s).toMatch(/…#[0-9a-z]+…/);
});

test("is stable for the same input", () => {
  expect(capSignature(deep(5), CAP)).toBe(capSignature(deep(5), CAP));
});

test("a single oversized segment keeps its end and stays distinct", () => {
  const x = capSignature(`${"x".repeat(400)}1`, 64);
  const y = capSignature(`${"x".repeat(400)}2`, 64);
  expect(x).not.toBe(y);
  expect(x.length).toBeLessThanOrEqual(64);
  expect(x.endsWith("1")).toBe(true);
});
