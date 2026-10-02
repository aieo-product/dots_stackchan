export interface QuietHours {
  readonly startMinute: number;
  readonly endMinute: number;
}

/** An empty setting disables quiet hours. Equal endpoints are ambiguous. */
export function parseQuietHours(value: string): QuietHours | undefined {
  if (value === "") return undefined;
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(value);
  if (match === null) throw new Error("QUIET_HOURS must be HH:mm-HH:mm or empty.");
  const [startHour, startMinute, endHour, endMinute] = match.slice(1).map(Number);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) {
    throw new Error("QUIET_HOURS contains an invalid time.");
  }
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  if (start === end) throw new Error("QUIET_HOURS endpoints must differ.");
  return { startMinute: start, endMinute: end };
}

export function isQuietHours(hours: QuietHours | undefined, at: number): boolean {
  if (hours === undefined) return false;
  const date = new Date(at);
  const minute = date.getHours() * 60 + date.getMinutes();
  return hours.startMinute < hours.endMinute
    ? minute >= hours.startMinute && minute < hours.endMinute
    : minute >= hours.startMinute || minute < hours.endMinute;
}

/** Find the actual local-clock exit, including skipped/repeated DST minutes. */
export function quietHoursEnd(hours: QuietHours, at: number): number {
  if (!isQuietHours(hours, at)) return at;
  const date = new Date(Math.floor(at / 60_000) * 60_000);
  while (isQuietHours(hours, date.getTime())) {
    date.setTime(date.getTime() + 60_000);
  }
  return date.getTime();
}
