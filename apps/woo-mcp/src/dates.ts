/** Calendar date (YYYY-MM-DD) of `now` in the given IANA timezone. */
export function localDate(now: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** `now` as an ISO 8601 timestamp with the timezone's UTC offset. */
export function localIso(now: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "longOffset",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : String(parts.timeZoneName).slice(3);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/**
 * Bounds for one store-local day. WooCommerce interprets `after`/`before`
 * without an offset in the site's timezone, so no conversion is needed.
 */
export function dayRange(date: string): { after: string; before: string } {
  return { after: `${date}T00:00:00`, before: `${date}T23:59:59` };
}
