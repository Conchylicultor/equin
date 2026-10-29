import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const calendarTodayIcon = symbol("calendar-today");

export const dateFieldType = defineFieldType<Date>("date");

export const dateIdentity = defineFieldIdentity<Date>({
  type: dateFieldType,
  kind: "instant",
  label: "Date",
  icon: calendarTodayIcon,
  customColumn: true,
  coerce: (v) =>
    v instanceof Date
      ? v.getTime()
      : v == null
        ? null
        : new Date(v as string).getTime(),
  directionLabels: { asc: "Oldest first", desc: "Newest first" },
});
