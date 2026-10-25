import { describe, expect, it } from "bun:test";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { ViewTypeMeta } from "../../core";
import type { ResolvedViewInstance } from "./resolve-instances";
import { resolveActiveId } from "./resolve-active-id";

const LIST_ICON = symbol("view-list");

// Only `instance.id` is read, so the viewType is a stand-in.
function inst(id: string): ResolvedViewInstance<ViewTypeMeta> {
  return {
    instance: { id, name: id, icon: LIST_ICON, pickedIcon: null, type: "list" },
    viewType: {} as ResolvedViewInstance<ViewTypeMeta>["viewType"],
  } as ResolvedViewInstance<ViewTypeMeta>;
}

const instances = [inst("active"), inst("recent"), inst("backups")];

const pick = (
  fromUrl: string | undefined,
  persisted: string | null,
  defaultView: string | undefined,
  pinned: string | undefined,
  from = instances,
) => resolveActiveId(from, { fromUrl, persisted, defaultView, pinned });

describe("resolveActiveId — unpinned", () => {
  it("prefers the persisted selection", () => {
    expect(pick(undefined, "backups", "recent", undefined)).toBe("backups");
  });

  it("falls back to the caller's default, then to the first instance", () => {
    expect(pick(undefined, "gone", "recent", undefined)).toBe("recent");
    expect(pick(undefined, null, undefined, undefined)).toBe("active");
    expect(pick(undefined, null, "recent", undefined, [])).toBe("");
  });
});

describe("resolveActiveId — from the URL", () => {
  it("outranks the persisted selection and the default", () => {
    expect(pick("recent", "backups", "active", undefined)).toBe("recent");
  });

  it("falls through when the URL names no authored view (a stale link)", () => {
    expect(pick("deleted", "backups", "recent", undefined)).toBe("backups");
    expect(pick("deleted", null, "recent", undefined)).toBe("recent");
  });
});

describe("resolveActiveId — pinned", () => {
  it("ignores the URL, the persisted selection and the default", () => {
    expect(pick("recent", "active", "recent", "backups")).toBe("backups");
  });

  it("resolves a pinned id that is not authored to '' — NEVER to another instance", () => {
    // The whole point: a mis-pinned host must be able to say so. Returning
    // `instances[0]` here would render the Active tab inside the backup app.
    expect(pick("recent", "active", "recent", "backup")).toBe("");
  });
});
