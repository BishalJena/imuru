// A store timezone is either an IANA name ("Asia/Kolkata") or, for stores set
// to a manual offset in WordPress, a fixed offset written "UTC+05:30".
const OFFSET = /^UTC([+-])(\d{2}):(\d{2})$/;

const offsetMinutes = (zone: string): number | null => {
  if (zone === "UTC") return 0;
  const m = OFFSET.exec(zone);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null;
};

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The store's zone from the WordPress REST index: timezone_string when set,
 * otherwise gmt_offset in hours (WordPress allows fractions such as 5.5).
 */
export function zoneOf(timezoneString: string, gmtOffsetHours: number): string {
  if (timezoneString) return timezoneString;
  const minutes = Math.round(gmtOffsetHours * 60);
  if (minutes === 0) return "UTC";
  const abs = Math.abs(minutes);
  return `UTC${minutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Wall-clock parts of `now` in the zone. */
function parts(now: Date, zone: string) {
  const fixed = offsetMinutes(zone);
  if (fixed !== null) {
    const t = new Date(now.getTime() + fixed * 60_000);
    const sign = fixed < 0 ? "-" : "+";
    const abs = Math.abs(fixed);
    return {
      year: String(t.getUTCFullYear()),
      month: pad(t.getUTCMonth() + 1),
      day: pad(t.getUTCDate()),
      hour: pad(t.getUTCHours()),
      minute: pad(t.getUTCMinutes()),
      second: pad(t.getUTCSeconds()),
      offset: `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
    };
  }
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
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
      .map((x) => [x.type, x.value]),
  );
  const name = String(p.timeZoneName);
  return {
    year: String(p.year),
    month: String(p.month),
    day: String(p.day),
    hour: String(p.hour),
    minute: String(p.minute),
    second: String(p.second),
    offset: name === "GMT" ? "+00:00" : name.slice(3),
  };
}

/** Calendar date (YYYY-MM-DD) of `now` in the store's zone. */
export function localDate(now: Date, zone: string): string {
  const p = parts(now, zone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** `now` as an ISO 8601 timestamp with the zone's UTC offset. */
export function localIso(now: Date, zone: string): string {
  const p = parts(now, zone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.offset}`;
}

const shiftDay = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Bounds for one store-local day. WooCommerce interprets `after`/`before`
 * without an offset in the site's timezone, and WordPress date queries treat
 * both as exclusive, so the bounds sit one second outside the day.
 */
export function dayRange(date: string): { after: string; before: string } {
  return { after: `${shiftDay(date, -1)}T23:59:59`, before: `${shiftDay(date, 1)}T00:00:00` };
}
