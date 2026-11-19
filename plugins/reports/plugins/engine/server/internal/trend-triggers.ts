import { defineDbTriggers } from "@plugins/database/plugins/db-triggers/server";

// The report history, kept by the database itself (./tables.ts, "The report
// history that outlives the reports themselves"). Triggers, not writer code:
// `reports` is written by recordReport's upsert and `report_fixes` by the fix
// ledger and the regression judge, and a counter in one of them would miss the
// others. Row-level: each statement touches one report or one fix.

// A report row inserted, or its count raised: the added occurrences join their
// day's counter, and its fingerprint joins the seen set (kept with the row's own
// first occurrence, so a report first seen before this trigger existed still
// carries its true first day).
const REPORTS_FN = `CREATE OR REPLACE FUNCTION report_trend_on_report()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  added int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    added := NEW.count;
  ELSE
    added := NEW.count - OLD.count;
  END IF;
  INSERT INTO report_fingerprints_seen (fingerprint, kind, first_seen_at)
  VALUES (NEW.fingerprint, NEW.kind, NEW.first_seen_at)
  ON CONFLICT (fingerprint) DO NOTHING;
  IF added > 0 THEN
    INSERT INTO report_trend_days (day, kind, occurrences)
    VALUES ((now() AT TIME ZONE 'UTC')::date, NEW.kind, added)
    ON CONFLICT (day, kind)
    DO UPDATE SET occurrences = report_trend_days.occurrences + EXCLUDED.occurrences;
  END IF;
  RETURN NULL;
END;
$$`;

// A fix landed (a new ledger row): one more landed on its day. A fixed report
// fired again from code containing the fix (regressed_at stamped): one more
// came back — counted on the day the FIX LANDED, so a day reads as a cohort
// ("of the fixes landed that day, how many came back so far"), the question
// "do fixes hold?" asks. Under the fixed report's kind (its row is there:
// report_fixes references it).
const FIXES_FN = `CREATE OR REPLACE FUNCTION report_trend_on_fix()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  k text;
BEGIN
  SELECT r.kind INTO k FROM reports r WHERE r.id = NEW.report_id;
  k := coalesce(k, 'unknown');
  IF TG_OP = 'INSERT' THEN
    INSERT INTO report_fix_days (day, kind, landed, regressed)
    VALUES ((NEW.landed_at AT TIME ZONE 'UTC')::date, k, 1, 0)
    ON CONFLICT (day, kind) DO UPDATE SET landed = report_fix_days.landed + 1;
  END IF;
  IF NEW.regressed_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.regressed_at IS NULL) THEN
    INSERT INTO report_fix_days (day, kind, landed, regressed)
    VALUES ((NEW.landed_at AT TIME ZONE 'UTC')::date, k, 0, 1)
    ON CONFLICT (day, kind) DO UPDATE SET regressed = report_fix_days.regressed + 1;
  END IF;
  RETURN NULL;
END;
$$`;

export const reportTrendTriggers = defineDbTriggers({
  id: "reports.trend",
  functions: [
    { name: "report_trend_on_report", args: "", ddl: REPORTS_FN },
    { name: "report_trend_on_fix", args: "", ddl: FIXES_FN },
  ],
  triggers: [
    {
      name: "report_trend_on_report",
      table: "reports",
      ddl: `CREATE OR REPLACE TRIGGER report_trend_on_report
  AFTER INSERT OR UPDATE OF count ON reports
  FOR EACH ROW
  EXECUTE FUNCTION report_trend_on_report()`,
    },
    {
      name: "report_trend_on_fix",
      table: "report_fixes",
      ddl: `CREATE OR REPLACE TRIGGER report_trend_on_fix
  AFTER INSERT OR UPDATE OF regressed_at ON report_fixes
  FOR EACH ROW
  EXECUTE FUNCTION report_trend_on_fix()`,
    },
  ],
});
