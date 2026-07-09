// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — local time
//
// Trilium records dates from the client-supplied `trilium-local-now-datetime`
// header (its own web client sends it on every request); absent it, Trilium
// falls back to the server clock. So BrainLLM sends its local now in Trilium's
// format on every write and uses the same notion of "today" everywhere — keeping
// dateCreated/dateModified, the calendar, sessions, logs and awareness all in the
// user's timezone, not the server's.
//
// Set BRAINLLM_TZ (IANA, e.g. "Africa/Johannesburg") when BrainLLM runs on a server in
// a different timezone than the user. Unset = the host's system local time
// (correct when BrainLLM runs on the user's own machine).
// ─────────────────────────────────────────────────────────────────────────────

const TZ = process.env.BRAINLLM_TZ?.trim() || undefined;

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function offsetStr(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** Local now in Trilium's local-datetime format: "YYYY-MM-DD HH:mm:ss.SSS+HHMM". */
export function localNowDateTime(): string {
  const now = new Date();
  const ms = pad(now.getMilliseconds(), 3);

  if (!TZ) {
    return (
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${ms}${offsetStr(-now.getTimezoneOffset())}`
    );
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(now);
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
  const year = g("year"), month = g("month"), day = g("day");
  const hour = g("hour"), minute = g("minute"), second = g("second");
  const wallUTC = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  const offsetMin = Math.round((wallUTC - now.getTime()) / 60000);

  return `${year}-${month}-${day} ${hour}:${minute}:${second}.${ms}${offsetStr(offsetMin)}`;
}

/** Local "today" — YYYY-MM-DD, in the same timezone as localNowDateTime(). */
export function localToday(): string {
  return localNowDateTime().slice(0, 10);
}

/** Local wall-clock time — HH:mm, in the same timezone as localNowDateTime().
 *  Used for intra-day addendum headers so they match the user's clock, not UTC. */
export function localNowTime(): string {
  return localNowDateTime().slice(11, 16);
}
