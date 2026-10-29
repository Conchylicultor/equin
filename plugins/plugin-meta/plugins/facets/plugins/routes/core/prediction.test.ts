import { expect, test } from "bun:test";
import {
  predictionDebt,
  predictionLabel,
  renderPredictionDebt,
  renderRoute,
} from "./prediction";
import type { RouteDef, RoutesData } from "./types";

const route = (r: string, prediction?: RouteDef["prediction"]): RouteDef => ({
  route: r,
  type: "http",
  runtime: "server",
  ...(prediction === undefined ? {} : { prediction }),
});
const data = (...routes: RouteDef[]): RoutesData => ({
  routes,
  endpointCallers: [],
});

test("labels and route lines", () => {
  expect(predictionLabel("predicted")).toBe("predicted");
  expect(predictionLabel({ unpredicted: "precondition" })).toBe(
    "unpredicted (precondition)",
  );
  expect(predictionLabel({ debt: "web-context" })).toBe("debt: web-context");
  expect(renderRoute(route("GET /api/x"))).toBe("`GET /api/x`");
  expect(renderRoute(route("POST /api/x", "internal"))).toBe(
    "`POST /api/x` — internal",
  );
});

test("debt index groups by gap, sorted", () => {
  const entries = predictionDebt([
    {
      plugin: "b",
      data: data(
        route("POST /api/b", { debt: "web-context" }),
        route("GET /api/g"),
      ),
    },
    {
      plugin: "a",
      data: data(
        route("POST /api/a", { debt: "web-context" }),
        route("POST /api/c", { debt: "another-gap" }),
        route("POST /api/p", "predicted"),
      ),
    },
    { plugin: "z", data: undefined },
  ]);
  expect(renderPredictionDebt(entries)).toEqual([
    "## Prediction debt by gap",
    "",
    "- `another-gap` — 1 route",
    "  - `POST /api/c` (`a`)",
    "- `web-context` — 2 routes",
    "  - `POST /api/a` (`a`)",
    "  - `POST /api/b` (`b`)",
  ]);
});

test("a gap past 20 routes is summarized per plugin; no debt renders nothing", () => {
  const many = Array.from({ length: 21 }, (_, i) =>
    route(`POST /api/r${i}`, { debt: "web-context" }),
  );
  const out = renderPredictionDebt(
    predictionDebt([
      { plugin: "big", data: data(...many.slice(0, 15)) },
      { plugin: "small", data: data(...many.slice(15)) },
    ]),
  );
  expect(out.slice(2)).toEqual([
    "- `web-context` — 21 routes",
    "  - `big` ×15",
    "  - `small` ×6",
  ]);
  expect(renderPredictionDebt([])).toEqual([]);
});
