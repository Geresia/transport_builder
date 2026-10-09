// B18-C1: operating-day classification is deliberately separate from the
// demand calendar.  A pack's demand factors say how many people travel; this
// small, explicit calendar says which timetable day type the simulator runs.
export const OPERATIONAL_CALENDAR_SCHEMA = "transitline.operational-calendar/1";
export const OPERATIONAL_DAY_TYPES = Object.freeze(["weekday", "weekend", "holiday"]);

const finiteDay = (value) => Number.isInteger(value) && value >= 0;
const text = (value) => typeof value === "string" && value ? value : null;
const clone = (value) => structuredClone(value);

export function defaultOperationalDayType(day) {
  if (!Number.isInteger(day)) return null;
  const weekday = ((day % 7) + 7) % 7;
  return weekday >= 5 ? "weekend" : "weekday";
}

// No inferred public holidays: a holiday exists only if the state explicitly
// records that operating-day number. Invalid calendar records are ignored by
// this query and reported by normalizeOperationalCalendar instead.
export function operationalDayTypeAtDay(day, calendar = null) {
  if (!Number.isInteger(day)) return null;
  const override = calendar?.dayTypesByOperatingDay?.[String(day)];
  return OPERATIONAL_DAY_TYPES.includes(override) ? override : defaultOperationalDayType(day);
}

export function operationalDayTypeAt(simMinutes, calendar = null) {
  const minutes = Number(simMinutes);
  return Number.isFinite(minutes) ? operationalDayTypeAtDay(Math.floor(minutes / 1440), calendar) : null;
}

export function normalizeOperationalCalendar(value) {
  if (value === null || value === undefined) return { calendar: null, warnings: [] };
  if (value?.schema !== OPERATIONAL_CALENDAR_SCHEMA || value?.contractVersion !== 1) return { calendar: null, warnings: ["operational-calendar-schema-invalid"] };
  const rows = value.dayTypesByOperatingDay;
  if (!rows || typeof rows !== "object" || Array.isArray(rows)) return { calendar: null, warnings: ["operational-calendar-days-invalid"] };
  const warnings = []; const dayTypesByOperatingDay = {};
  for (const [rawDay, rawType] of Object.entries(rows)) {
    const day = Number(rawDay); const type = text(rawType);
    if (!finiteDay(day) || String(day) !== rawDay || !OPERATIONAL_DAY_TYPES.includes(type)) { warnings.push(`operational-calendar-entry-invalid:${rawDay}`); continue; }
    dayTypesByOperatingDay[String(day)] = type;
  }
  return { calendar: { schema: OPERATIONAL_CALENDAR_SCHEMA, contractVersion: 1, dayTypesByOperatingDay }, warnings: warnings.sort() };
}

export function calendarSupportsDayType(calendar, dayType) {
  if (!OPERATIONAL_DAY_TYPES.includes(dayType)) return false;
  if (dayType !== "holiday") return true;
  return Object.values(calendar?.dayTypesByOperatingDay ?? {}).includes("holiday");
}

export function setOperationalCalendar(state, value) {
  const normalized = normalizeOperationalCalendar(value);
  state.operationalCalendar = normalized.calendar === null ? null : clone(normalized.calendar);
  return { calendar: state.operationalCalendar === null ? null : clone(state.operationalCalendar), warnings: [...normalized.warnings] };
}
