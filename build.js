// Builds the site into _site/:
//   README.md                     -> index.html
//   Readings/YYYY-MM-DD-slug.*    -> copied, linked from the schedule
//   MeetingNotes/YYYY-MM-DD-*.md  -> meetings/<slug>/index.html, linked from the schedule
// Anything without a YYYY-MM-DD- filename prefix is ignored.
// A reading whose slug ends in -excerpt is a companion to that session's full
// text: it is linked as EXCERPT beside NOTES rather than leading the row.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { marked } from 'marked';

const OUT = '_site';
const SITE_TITLE = 'Personhood Research Group';
const DATED = /^(\d{4}-\d{2}-\d{2})-(.+)$/;
const EXCERPT = /-excerpt$/;

const titleize = (slug) =>
  slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());

const longDate = (iso) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB',
    { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Collect dated entries from a directory.
function entries(dir, kind) {
  let files;
  try { files = readdirSync(dir); } catch { return []; }
  return files.flatMap((file) => {
    const m = DATED.exec(basename(file, extname(file)));
    if (!m) return [];
    const [, date, slug] = m;
    return [{ kind, date, slug, file, source: join(dir, file), ext: extname(file) }];
  });
}

const readings = entries('Readings', 'reading');
const meetings = entries('MeetingNotes', 'meeting').filter((e) => e.ext === '.md');

// A meeting note's <h1> wins over its filename for the title.
for (const m of meetings) {
  m.body = readFileSync(m.source, 'utf8');
  const heading = /^#\s+(.+)$/m.exec(m.body);
  m.title = heading ? heading[1].trim() : titleize(m.slug);
  m.url = `meetings/${m.date}-${m.slug}/`;
}
for (const r of readings) {
  r.title = titleize(r.slug);
  r.url = `readings/${r.file}`;
  if (EXCERPT.test(r.slug)) r.kind = 'excerpt';
}

// One row per date: a session's notes, reading(s) and excerpt(s) share a line.
const BUCKET = { meeting: 'meetings', reading: 'readings', excerpt: 'excerpts' };
const byDate = new Map();
for (const e of [...meetings, ...readings]) {
  if (!byDate.has(e.date)) byDate.set(e.date, { date: e.date, meetings: [], readings: [], excerpts: [] });
  byDate.get(e.date)[BUCKET[e.kind]].push(e);
}
const schedule = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));

const page = (title, main, { home = false } = {}) => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<link rel="stylesheet" href="${home ? '' : '../../'}style.css">
<body>
<header><a class="home" href="${home ? '.' : '../../'}">${escape(SITE_TITLE)}</a></header>
<main>
${main}
</main>
</body>
</html>
`;

const link = (e, text, cls) => `<a${cls ? ` class="${cls}"` : ''} href="${e.url}">${escape(text ?? e.title)}</a>`;

// The row leads with the full reading, falling back to an excerpt and then to the
// notes; whichever of those did not lead sits at the right as EXCERPT / NOTES.
function row(day) {
  const lead = [day.readings, day.excerpts, day.meetings].find((g) => g.length) ?? [];
  const also = [
    ...(lead === day.excerpts ? [] : day.excerpts).map((r) => link(r, 'excerpt', 'kind')),
    ...(lead === day.meetings ? [] : day.meetings).map((m) => link(m, 'notes', 'kind')),
  ];
  return `  <li>
    <time datetime="${day.date}">${longDate(day.date)}</time>
    <span class="what">${lead.map((e) => link(e)).join(' · ')}</span>${also.length ? `
    <span class="also">${also.join(' · ')}</span>` : ''}
  </li>`;
}

const scheduleHtml = schedule.length
  ? `<ul class="schedule">\n${schedule.map(row).join('\n')}\n</ul>`
  : '<p class="empty">Nothing scheduled yet.</p>';

// Write everything out.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let readme = '';
try { readme = marked.parse(readFileSync('README.md', 'utf8')); } catch {}

writeFileSync(join(OUT, 'index.html'),
  page(SITE_TITLE, `${readme}\n<h2 id="schedule">Meetings &amp; readings</h2>\n${scheduleHtml}`, { home: true }));

for (const m of meetings) {
  mkdirSync(join(OUT, m.url), { recursive: true });
  writeFileSync(join(OUT, m.url, 'index.html'),
    page(`${m.title} — ${SITE_TITLE}`,
      `<p class="meta"><time datetime="${m.date}">${longDate(m.date)}</time></p>\n${marked.parse(m.body)}`));
}

if (readings.length) mkdirSync(join(OUT, 'readings'), { recursive: true });
for (const r of readings) cpSync(r.source, join(OUT, r.url));

cpSync('style.css', join(OUT, 'style.css'));

console.log(`built ${OUT}/: ${meetings.length} meeting note(s), ${readings.length} reading(s)`);
