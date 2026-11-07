// Reads the group's public Google Calendar feed (iCalendar format) at build time.
//
// Only what the site shows is extracted: each event's start, end and summary.
// Descriptions are never read, since they can carry meeting links.
// Events are kept only if their summary matches `include`, so other series on the
// same calendar (e.g. an old working group) never reach the site.
// Recurring series are skipped with a warning: the group schedules sessions one by
// one, and expanding RRULEs properly is more than this needs.
//
// A failed fetch never fails the build: it warns and returns no events, and the
// site falls back to the dates of the readings and notes in the repo.

const icsUrl = (id) =>
  `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;

export const subscribeUrl = (id) =>
  `https://calendar.google.com/calendar/u/0?cid=${Buffer.from(id).toString('base64')}`;

// Lines longer than 75 octets are folded onto continuation lines that begin with
// a space or tab.
const unfold = (text) => text.replace(/\r?\n[ \t]/g, '');

// "DTSTART;TZID=Europe/Berlin:20261108T170000" -> { name, params, value }
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const [name, ...params] = line.slice(0, colon).split(';');
  return {
    name: name.toUpperCase(),
    params: Object.fromEntries(params.map((p) => p.split('=')).map(([k, v]) => [k.toUpperCase(), v])),
    value: line.slice(colon + 1),
  };
}

// The UTC offset (ms) of `timeZone` at instant `t`.
function offset(t, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(t).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - t;
}

// An iCalendar DATE or DATE-TIME -> { start: Date, allDay }.
function parseTime({ params, value }, fallbackZone) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { start: new Date(Date.UTC(+y, mo - 1, +d)), allDay: true };
  const wall = Date.UTC(+y, mo - 1, +d, +h, +mi, +s);
  if (z) return { start: new Date(wall), allDay: false };
  // Floating or TZID-qualified local time: shift by the zone's offset (twice, so
  // times near a DST change land on the right side of it).
  const zone = params.TZID ?? fallbackZone;
  try {
    let t = wall - offset(wall, zone);
    t = wall - offset(t, zone);
    return { start: new Date(t), allDay: false };
  } catch {
    return { start: new Date(wall), allDay: false };
  }
}

// YYYY-MM-DD of an instant as seen in `timeZone`.
const dayIn = (date, timeZone) => date.toLocaleDateString('en-CA', { timeZone });

// The only event properties kept. DESCRIPTION, LOCATION etc. are dropped on read.
const FIELDS = new Set(['SUMMARY', 'DTSTART', 'STATUS', 'RRULE', 'RECURRENCE-ID']);

export function parseEvents(text, { include }) {
  const lines = unfold(text).split(/\r?\n/).map(parseLine).filter(Boolean);
  const zone = lines.find((l) => l.name === 'X-WR-TIMEZONE')?.value || 'UTC';
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line.name === 'BEGIN' && line.value === 'VEVENT') ev = {};
    else if (line.name === 'END' && line.value === 'VEVENT') {
      const summary = (ev.SUMMARY?.value ?? '').replace(/\\([,;\\])/g, '$1').trim();
      const time = ev.DTSTART && parseTime(ev.DTSTART, zone);
      if (!include.test(summary) || !time || ev.STATUS?.value === 'CANCELLED') { /* not ours */ }
      else if (ev.RRULE || ev['RECURRENCE-ID']) {
        console.warn(`calendar: skipping recurring event "${summary}"; schedule sessions individually`);
      } else {
        events.push({
          date: time.allDay ? time.start.toISOString().slice(0, 10) : dayIn(time.start, zone),
          start: time.allDay ? null : time.start,
          timeZone: zone,
        });
      }
      ev = null;
    } else if (ev && FIELDS.has(line.name) && !(line.name in ev)) ev[line.name] = line;
  }
  return events;
}

export async function fetchEvents(id, { include, timeoutMs = 10000 }) {
  try {
    const res = await fetch(icsUrl(id), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseEvents(await res.text(), { include });
  } catch (err) {
    console.warn(`calendar: could not fetch the calendar feed (${err.message}); building without it`);
    return [];
  }
}
