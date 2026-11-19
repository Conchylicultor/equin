import { useId, type CSSProperties } from "react";
import "./agent-crew.css";

/**
 * The bottom of the iceberg: the agents that built everything above it, as
 * three small robots hovering on their thrusters over a lit sea floor, with
 * the agent's name under them. Two are carriers — each holds a block, flies
 * up behind the last layer's cards, fades into the dark and comes back down
 * empty for the next one — and one patrols its stretch of the floor, turning
 * to face where it goes. Bubbles rise off each robot and drift up from the
 * floor between them. Pure CSS motion, so it runs without the card runtime.
 */

/** [left %, carries a block, travel px (up for a carrier, across for a patrol), seconds per trip, delay s, scale] */
const CREW: readonly (readonly [
  number,
  boolean,
  number,
  number,
  number,
  number,
])[] = [
  [22, true, 230, 9, -2, 1],
  [50, false, 150, 10, 0, 1.2],
  [78, true, 230, 11, -6.5, 1],
];

/** Loose bubbles drifting up from the floor: [left %, delay s, radius px]. */
const LOOSE: readonly (readonly [number, number, number])[] = [
  [14, 0, 3],
  [33, 2.2, 2],
  [46, 4.1, 2.5],
  [64, 1.3, 3.5],
  [86, 3.4, 2],
];

export function AgentCrew() {
  // the robots' gradients, one set per page (the scene is mounted once, but ids must never collide)
  const id = useId().replace(/[^\w-]/g, "");
  const grad = `${id}-eye`;
  const jet = `${id}-jet`;
  return (
    <div className="iceberg-agents" aria-hidden="true">
      <svg width="0" height="0" className="iceberg-agents-defs">
        <defs>
          <linearGradient id={grad} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--berg-blue)" />
            <stop offset="1" stopColor="var(--berg-cyan)" />
          </linearGradient>
          <linearGradient id={jet} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--berg-blue-2)" stopOpacity=".9" />
            <stop offset="1" stopColor="var(--berg-cyan)" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
      <div className="iceberg-agents-stage">
        {LOOSE.map(([x, d, r]) => (
          <span
            key={x}
            className="iceberg-agents-loose"
            style={
              {
                left: `${x}%`,
                width: r * 2,
                height: r * 2,
                "--agent-delay": `${d}s`,
              } as CSSProperties
            }
          />
        ))}
        {CREW.map(([x, carry, travel, t, d, sc]) => (
          <div
            key={x}
            className={`iceberg-agent ${carry ? "iceberg-agent-carrier" : "iceberg-agent-patrol"}`}
            style={
              {
                left: `${x}%`,
                "--agent-travel": `${travel}px`,
                "--agent-trip": `${t}s`,
                "--agent-delay": `${d}s`,
                "--agent-scale": sc,
              } as CSSProperties
            }
          >
            <div className="iceberg-agent-flip">
              <Robot
                carry={carry}
                delay={d}
                eye={`url(#${grad})`}
                jet={`url(#${jet})`}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="iceberg-agents-floor" />
      <div className="iceberg-agents-name">Claude</div>
    </div>
  );
}

/**
 * One hovering robot, 80 × 92 units, facing right. Its arms are soft curves
 * swaying from the shoulder; a carrier's hold its block in front and hang
 * loose on the way back down.
 */
function Robot({
  carry,
  delay,
  eye,
  jet,
}: {
  carry: boolean;
  delay: number;
  eye: string;
  jet: string;
}) {
  return (
    <svg className="iceberg-agent-svg" viewBox="0 0 80 92">
      <g className="ra-hover">
        <g className="ra-arms-free">
          <g className="ra-sway" style={{ transformOrigin: "24px 52px" }}>
            <path d="M24 52 C17 56 16 63 19 68" className="ra-arm ra-back" />
            <circle cx="19" cy="69" r="2.4" className="ra-hand ra-back" />
          </g>
          <g
            className="ra-sway ra-sway-b"
            style={{ transformOrigin: "56px 52px" }}
          >
            <path d="M56 52 C63 56 64 63 61 68" className="ra-arm" />
            <circle cx="61" cy="69" r="2.4" className="ra-hand" />
          </g>
        </g>
        {carry && (
          <g className="ra-arms-hold">
            <path d="M24 53 C30 46 44 40 54 41" className="ra-arm ra-back" />
            <rect
              x="50"
              y="26"
              width="18"
              height="15"
              rx="3.5"
              className="ra-crate"
            />
            <path d="M50 33.5 H68" className="ra-crate-line" />
            <path d="M56 53 C64 52 67 47 66 42" className="ra-arm" />
            <circle cx="66" cy="41.5" r="2.4" className="ra-hand" />
          </g>
        )}
        <path d="M40 22 V15" className="ra-wire" />
        <circle cx="40" cy="12.5" r="2.8" className="ra-tip" />
        <rect
          x="25"
          y="22"
          width="30"
          height="22"
          rx="9"
          className="ra-shell"
        />
        <rect
          x="30"
          y="27"
          width="23"
          height="12"
          rx="5"
          className="ra-visor"
        />
        <g className="ra-eyes">
          <rect x="38" y="29.5" width="3.6" height="7" rx="1.8" fill={eye} />
          <rect x="45.5" y="29.5" width="3.6" height="7" rx="1.8" fill={eye} />
        </g>
        <path d="M40 44 V47" className="ra-wire" />
        <rect
          x="22"
          y="47"
          width="36"
          height="19"
          rx="9"
          className="ra-shell"
        />
        <rect x="28" y="54" width="9" height="3" rx="1.5" className="ra-led" />
        <path d="M31 66 H49 L45 71 H35 Z" className="ra-shell" />
        <path d="M35 72 Q40 88 45 72 Z" className="ra-jet" fill={jet} />
        {(
          [
            [44, 0],
            [50, 1.1],
            [38, 2],
          ] as const
        ).map(([x, b]) => (
          <circle
            key={x}
            cx={x}
            cy="18"
            r={1.6 + (b % 1)}
            className="ra-bubble"
            style={
              {
                "--agent-delay": `${(b + (-delay % 1.7)).toFixed(2)}s`,
              } as CSSProperties
            }
          />
        ))}
      </g>
    </svg>
  );
}
