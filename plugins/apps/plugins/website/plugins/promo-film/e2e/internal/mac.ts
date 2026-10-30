// 47.54–52.64 s · Mac: Circle's window stays where it is while everything
// around it turns into macOS — a wallpaper, the menu bar and a Dock rebuilt
// from the apps' real icons. The tray icon drops the equin menu-bar panel;
// Places opens from it in its own window and gets its own Dock icon.

import {
  group,
  html,
  image,
  shape,
  type GroupLayer,
  type Key,
  type Layer,
  type SfxCue,
} from "@plugins/media/plugins/film/e2e";
import { cursor, fadeIn, type Ctx, type Scene } from "./kit";
import { SECTIONS } from "./timeline";

const MENU_H = 26;
const TRAY_X = 1060; // centre of the equin tray icon in the menu bar
const PANEL_W = 340;
const PANEL = { x: TRAY_X - PANEL_W / 2, y: MENU_H + 6 };
/** The Places icon's centre inside the menu-bar panel (panel coordinates). */
const PANEL_PLACES = { x: 290, y: 271 };

const ICON = 46;
const GAP = 8;
const PAD = 8;
const DOCK_H = ICON + 2 * PAD;
const DOCK_Y = 720 - 10 - DOCK_H;
const DOCK_APPS = [
  "agent-manager",
  "pages",
  "mail",
  "sonata",
  "file-explorer",
  "prototypes",
  "settings",
];

const TRAFFIC = `<span style="display:inline-flex;gap:8px;align-items:center"><i style="width:12px;height:12px;border-radius:50%;background:#ff5f57;display:block"></i><i style="width:12px;height:12px;border-radius:50%;background:#febc2e;display:block"></i><i style="width:12px;height:12px;border-radius:50%;background:#28c840;display:block"></i></span>`;

function titleBar(title: string, width: number, dark: boolean): string {
  const bg = dark ? "#1f2024" : "#ececef";
  const fg = dark ? "rgba(255,255,255,0.78)" : "rgba(0,0,0,0.72)";
  return `<div style="width:${width}px;height:28px;background:${bg};display:flex;align-items:center;padding:0 12px;position:relative;font:600 12.5px 'Inter Variable',Inter,sans-serif;color:${fg};border-bottom:1px solid ${dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)"}">${TRAFFIC}<div style="position:absolute;left:0;right:0;text-align:center;pointer-events:none">${title}</div></div>`;
}

const APPLE = `<svg width="14" height="16" viewBox="0 0 814 1000" fill="#111"><path d="M788 341c-6 4-108 62-108 190 0 148 130 200 134 202-1 3-21 72-69 142-43 62-88 124-156 124s-86-40-164-40c-77 0-104 41-167 41s-106-58-156-129C44 789 0 669 0 555c0-183 119-280 236-280 62 0 114 41 153 41 37 0 95-43 166-43 27 0 124 2 188 99zM558 170c29-35 50-83 50-131 0-7-1-14-2-19-48 2-104 32-138 72-27 30-52 79-52 128 0 7 1 15 2 17 3 1 8 1 13 1 43 0 97-29 127-68z"/></svg>`;

const MENU_BAR = `<div style="width:1280px;height:${MENU_H}px;display:flex;align-items:center;padding:0 18px;gap:20px;background:rgba(246,246,250,0.62);backdrop-filter:blur(24px) saturate(1.6);-webkit-backdrop-filter:blur(24px) saturate(1.6);font:500 13px 'Inter Variable',Inter,sans-serif;color:#141414;letter-spacing:-0.01em;position:relative;box-shadow:0 1px 0 rgba(0,0,0,0.06)">
${APPLE}<b style="font-weight:700">Circle</b><span>File</span><span>Edit</span><span>View</span><span>Window</span><span>Help</span>
<div style="position:absolute;left:${TRAY_X - 9}px;top:4px;width:18px;height:18px">
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#141414" stroke-width="2.2" stroke-linecap="round"><path d="M4.5 12a7.5 7.5 0 0 0 15 0"/><path d="M8 12a4 4 0 0 0 8 0"/><circle cx="12" cy="7" r="1.6" fill="#141414" stroke="none"/></svg></div>
<svg style="position:absolute;left:${TRAY_X + 26}px;top:6px" width="17" height="14" viewBox="0 0 24 18" fill="#141414"><path d="M12 15.5l2.6-3a3.6 3.6 0 0 0-5.2 0zM5.9 9.4l1.9 2.1a6 6 0 0 1 8.4 0l1.9-2.1a8.8 8.8 0 0 0-12.2 0zM2 5.2l1.9 2.1a11.6 11.6 0 0 1 16.2 0L22 5.2a14.4 14.4 0 0 0-20 0z"/></svg>
<div style="position:absolute;left:${TRAY_X + 56}px;top:8px;width:24px;height:11px;border:1.4px solid rgba(20,20,20,0.55);border-radius:3px;padding:1px"><div style="width:72%;height:100%;background:#141414;border-radius:1px"></div></div>
<span style="position:absolute;right:18px;top:5px">Wed 28 Oct&nbsp;&nbsp;16:16</span></div>`;

const WALLPAPER = `<div style="width:1280px;height:720px;background:
radial-gradient(ellipse 70% 60% at 18% 85%, rgba(255,140,90,0.55), transparent 60%),
radial-gradient(ellipse 60% 70% at 85% 20%, rgba(120,90,255,0.55), transparent 60%),
radial-gradient(ellipse 80% 80% at 50% 50%, #2a3f9a 0%, #182660 45%, #0c1233 100%)"></div>`;

export function mac(
  _ctx: Ctx,
  /** The group's own motion after the section (the iceberg shrinks it into a card). */
  after: Pick<GroupLayer, "x" | "y" | "scale" | "opacity" | "end" | "origin">,
): Scene {
  const t0 = SECTIONS.mac.from; // 47.54
  const trayClick = 49.24;
  const panelAt = trayClick + 0.05;
  const appClick = 50.09;
  const openAt = appClick + 0.06;
  const opened = openAt + 0.65;
  const dockAdd = openAt + 0.3;

  const dockX = (n: number): number =>
    640 - (n * ICON + (n - 1) * GAP + 2 * PAD) / 2;
  const n0 = DOCK_APPS.length;
  const iconX = (i: number, n: number): number =>
    dockX(n) + PAD + i * (ICON + GAP);
  const slide = (from: number, to: number): Key[] => [
    [dockAdd, from],
    [dockAdd + 0.45, to, "outCubic"],
  ];
  const iconScale = ICON / 72;
  const dockIcons: Layer[] = DOCK_APPS.map((app, i) =>
    image(`tile-${app}-icon`, {
      origin: [0, 0],
      scale: iconScale,
      x: slide(iconX(i, n0), iconX(i, n0 + 1)),
      y: DOCK_Y + PAD,
    }),
  );
  const placesIdx = n0; // appended at the end
  dockIcons.push(
    image("tile-places-icon", {
      start: dockAdd,
      origin: [ICON / iconScale / 2, ICON / iconScale],
      scale: [
        [dockAdd, 0],
        [dockAdd + 0.5, iconScale, { spring: { bounce: 0.35 } }],
      ],
      x: iconX(placesIdx, n0 + 1),
      y: DOCK_Y + PAD,
    }),
  );
  const dot = (x: Key[] | number, start?: number): Layer =>
    shape(
      {
        kind: "rect",
        width: 4,
        height: 4,
        fill: "rgba(255,255,255,0.85)",
        radius: 2,
      },
      { x, y: DOCK_Y + DOCK_H - 5, start },
    );
  const protoI = DOCK_APPS.indexOf("prototypes");
  const dock = group(
    [
      shape(
        {
          kind: "rect",
          width: [
            [dockAdd, n0 * ICON + (n0 - 1) * GAP + 2 * PAD],
            [dockAdd + 0.45, (n0 + 1) * ICON + n0 * GAP + 2 * PAD, "outCubic"],
          ],
          height: DOCK_H,
          fill: "rgba(255,255,255,0.18)",
          radius: 18,
          border: "1px solid rgba(255,255,255,0.28)",
        },
        {
          x: slide(dockX(n0), dockX(n0 + 1)),
          y: DOCK_Y,
          style: {
            "backdrop-filter": "blur(20px) saturate(1.5)",
            "-webkit-backdrop-filter": "blur(20px) saturate(1.5)",
          },
          shadow: "0 10px 30px rgba(0,0,0,0.25)",
        },
      ),
      ...dockIcons,
      dot(
        slide(
          iconX(protoI, n0) + ICON / 2 - 2,
          iconX(protoI, n0 + 1) + ICON / 2 - 2,
        ),
      ),
      dot(iconX(placesIdx, n0 + 1) + ICON / 2 - 2, dockAdd + 0.3),
    ],
    {
      y: [
        [t0 + 0.35, 90],
        [t0 + 0.95, 0, "outCubic"],
      ],
    },
  );

  // Circle's window: same place, same size as the desktop window's content.
  const circleScale = 880 / 1280;
  const circleWin = group(
    [
      html(titleBar("Circle — P2P friends", 880, true), 880, 28),
      image("circle-single", { origin: [0, 0], scale: circleScale, y: 28 }),
    ],
    {
      width: 880,
      height: 28 + 720 * circleScale,
      x: 96,
      y: 136 - 28,
      radius: 11,
      shadow: "0 30px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)",
      opacity: fadeIn(t0, 0.5),
    },
  );

  // Places' own window, opened from the panel (grows from its icon).
  const pw = 760;
  const pScale = pw / 1280;
  const pwin = { x: 330, y: 150 };
  const iconAt = { x: PANEL.x + PANEL_PLACES.x, y: PANEL.y + PANEL_PLACES.y };
  const placesWin = group(
    [
      html(titleBar("Places", pw, false), pw, 28),
      image("places-after", { origin: [0, 0], scale: pScale, y: 28 }),
    ],
    {
      start: openAt,
      width: pw,
      height: 28 + 720 * pScale,
      x: pwin.x,
      y: pwin.y,
      radius: 11,
      shadow: "0 30px 90px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.12)",
      origin: [iconAt.x - pwin.x, iconAt.y - pwin.y],
      scale: [
        [openAt, 0.06],
        [opened, 1, { spring: { bounce: 0.12 } }],
      ],
      opacity: fadeIn(openAt, 0.15),
    },
  );

  const layers: Layer[] = [
    group(
      [
        html(WALLPAPER, 1280, 720, { opacity: fadeIn(t0, 0.7) }),
        circleWin,
        placesWin,
        dock,
        html(MENU_BAR, 1280, MENU_H, {
          y: [
            [t0 + 0.3, -MENU_H - 4],
            [t0 + 0.8, 0, "outCubic"],
          ],
        }),
        image("menu-panel", {
          start: panelAt,
          end: openAt + 0.25,
          x: PANEL.x,
          y: PANEL.y,
          radius: 12,
          shadow: "0 20px 50px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.1)",
          origin: [PANEL_W / 2, 0],
          scale: [
            [panelAt, 0.96],
            [panelAt + 0.35, 1, { spring: { bounce: 0.2 } }],
            [openAt, 1],
            [openAt + 0.2, 0.98],
          ],
          opacity: [
            [panelAt, 0],
            [panelAt + 0.15, 1],
            [openAt, 1],
            [openAt + 0.22, 0],
          ],
        }),
        cursor(
          [
            [t0 + 1.0, 760, 470],
            [trayClick - 0.1, TRAY_X, 13],
            [trayClick + 0.25, TRAY_X, 13],
            [appClick - 0.12, iconAt.x, iconAt.y],
          ],
          [trayClick, appClick],
          appClick + 0.35,
        ),
      ],
      {
        id: "mac",
        start: t0,
        width: 1280,
        height: 720,
        ...after,
      },
    ),
  ];

  const sfx: SfxCue[] = [
    { kind: "whoosh", at: t0 + 0.25, dur: 0.7, gain: 0.25, dir: "down" },
    { kind: "click", at: trayClick },
    { kind: "pop", at: panelAt + 0.03, pitch: 4, gain: 0.45 },
    { kind: "click", at: appClick },
    { kind: "whoosh", at: openAt, dur: 0.55, gain: 0.3, dir: "up" },
    { kind: "pop", at: dockAdd + 0.15, pitch: 0, gain: 0.45 },
  ];

  return {
    layers,
    sfx,
    cam: {
      zoom: [
        [t0, 1],
        [SECTIONS.mac.to, 1.03, "linear"],
      ],
    },
  };
}
