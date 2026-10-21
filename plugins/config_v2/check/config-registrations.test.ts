import { describe, expect, test } from "bun:test";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { collectConfigRegistrations } from "./config-registrations";

const webRegister = { id: "config_v2.web-register" } as unknown as SlotHandle;
const otherSlot = { id: "other.slot" } as unknown as SlotHandle;
const registerKind = Symbol("ConfigV2.Register");

describe("collectConfigRegistrations", () => {
  test("reads web registrations by slot identity and server ones by kind", () => {
    const regs = collectConfigRegistrations(
      [
        {
          runtime: "web",
          pluginId: "ui.tab-bar",
          barrel: "plugins/ui/plugins/tab-bar/web/index.ts",
          contributions: [
            { _slot: webRegister, descriptor: { name: "config" } },
            { _slot: otherSlot, descriptor: { name: "ignored" } },
          ],
        },
        {
          runtime: "server",
          pluginId: "ui.tab-bar",
          barrel: "plugins/ui/plugins/tab-bar/server/index.ts",
          contributions: [
            { _kind: registerKind, descriptor: { name: "config" } },
            { _kind: Symbol("Other"), descriptor: { name: "ignored" } },
          ],
        },
      ],
      webRegister,
    );
    expect(regs).toEqual([
      {
        runtime: "web",
        registrar: "ui.tab-bar",
        owner: "ui.tab-bar",
        storePath: "ui/tab-bar/config.jsonc",
        barrel: "plugins/ui/plugins/tab-bar/web/index.ts",
      },
      {
        runtime: "server",
        registrar: "ui.tab-bar",
        owner: "ui.tab-bar",
        storePath: "ui/tab-bar/config.jsonc",
        barrel: "plugins/ui/plugins/tab-bar/server/index.ts",
      },
    ]);
  });

  test("a pluginId override stores under the owner but keeps the registrar", () => {
    const [reg] = collectConfigRegistrations(
      [
        {
          runtime: "machine",
          pluginId: "reorder",
          barrel: "plugins/reorder/machine/index.ts",
          contributions: [
            {
              _kind: registerKind,
              pluginId: "shell",
              descriptor: { name: "sidebar" },
            },
          ],
        },
      ],
      webRegister,
    );
    expect(reg).toMatchObject({
      runtime: "machine",
      registrar: "reorder",
      owner: "shell",
      storePath: "shell/sidebar.jsonc",
    });
  });

  test("a web contribution never counts as a server registration", () => {
    expect(
      collectConfigRegistrations(
        [
          {
            runtime: "server",
            pluginId: "ui.tab-bar",
            barrel: "plugins/ui/plugins/tab-bar/server/index.ts",
            contributions: [{ _slot: webRegister, descriptor: { name: "c" } }],
          },
        ],
        webRegister,
      ),
    ).toEqual([]);
  });
});
