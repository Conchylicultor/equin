import { defineDbTriggers } from "@plugins/database/plugins/db-triggers/server";

// A notification's place in the bell is its `created_at`, and a place never
// changes: moving a row is dismissing what was below it, so the database
// refuses it. A recurrence that deserves a new alert is a NEW row
// (`writeNotification`), never an old one floated to the top.
const KEEP_CREATED_AT_FN = `CREATE OR REPLACE FUNCTION notifications_keep_created_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notification %: created_at is its position in the bell and never changes (% -> %) — file a new notification instead of moving this one', OLD.id, OLD.created_at, NEW.created_at
    USING ERRCODE = 'check_violation';
END;
$$`;

export const notificationStablePositionTriggers = defineDbTriggers({
  id: "notifications.stable-position",
  functions: [
    {
      name: "notifications_keep_created_at",
      args: "",
      ddl: KEEP_CREATED_AT_FN,
    },
  ],
  triggers: [
    {
      name: "notifications_keep_created_at",
      table: "notifications",
      ddl: `CREATE OR REPLACE TRIGGER notifications_keep_created_at
  BEFORE UPDATE OF created_at ON notifications
  FOR EACH ROW
  WHEN (OLD.created_at IS DISTINCT FROM NEW.created_at)
  EXECUTE FUNCTION notifications_keep_created_at()`,
    },
  ],
});
