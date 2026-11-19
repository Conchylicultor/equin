export {
  responsivenessScoreboard,
  ScoreboardSchema,
  SCOREBOARD_DAYS,
  SCOREBOARD_KINDS_MAX,
  SCOREBOARD_METRICS,
} from "./internal/value";
export type {
  Scoreboard,
  ScoreboardDay,
  ScoreboardFixKind,
  ScoreboardKind,
  ScoreboardMetric,
  ScoreboardSeries,
  ScoreboardStat,
  ScoreboardWeek,
} from "./internal/value";
export {
  feltSeries,
  scoreboardHeadline,
  trendOf,
  weekOf,
} from "./internal/headline";
export type { Trend } from "./internal/headline";
