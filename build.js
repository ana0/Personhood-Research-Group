// Builds the site into _site/:
//   README.md                     -> index.html (up to a `<!-- hidden -->` line)
//   Readings/YYYY-MM-DD-slug.*    -> copied, linked from the schedule
//   MeetingNotes/YYYY-MM-DD-*.md  -> meetings/<slug>/index.html, linked from the schedule
//   PAGES (standing documents)    -> <slug>/index.html
//   Google Calendar (CALENDAR_ID)  -> meeting times, merged into the schedule by date
// Anything in those dated directories without a YYYY-MM-DD- prefix is ignored.
// A reading whose slug ends in -excerpt is a companion to that session's full
// text: it is linked as EXCERPT beside NOTES rather than leading the row.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, extname, basename, posix } from 'node:path';
import { marked } from 'marked';
import { fetchEvents, subscribeUrl } from './calendar.js';

const OUT = '_site';
const SITE_TITLE = 'Personhood Research Group';
const DATED = /^(\d{4}-\d{2}-\d{2})-(.+)$/;
const EXCERPT = /-excerpt$/;

// The group's public Google Calendar. Only events whose title names the group are
// used; the calendar also holds other series that must not appear on the site.
const CALENDAR_ID = '2103a95d2dc21927d203f9e8933b72fc3e09dadda13dc1294517218621a19ae8@group.calendar.google.com';
const CALENDAR_INCLUDE = /\bPersonhood Research Group\b|^PRG\b/i;

// Standing documents. Unlike readings and notes these are undated: they are revised
// in place as the group collects questions and nominations. Link to one from any
// markdown file by its repo-relative path and the build points it at the built page.
const PAGES = [
  { file: 'researchquestions.md', slug: 'research-questions', title: 'Research questions' },
  { file: 'prospectivereadings.md', slug: 'prospective-readings', title: 'Prospective readings' },
];

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

// A missing standing document is not an error: the page is simply not built, and
// links to it keep pointing at the markdown file.
const pages = PAGES.flatMap((p) => {
  let body;
  try { body = readFileSync(p.file, 'utf8'); } catch { return []; }
  return [{ ...p, body, url: `${p.slug}/` }];
});

// Links to a standing document are written as repo-relative markdown paths, so that
// they resolve to the file in the repo when the markdown is read on GitHub. Here they
// are rewritten to the built page instead. Any #anchor or ?query rides along.
const PAGE_URL = new Map(pages.map((p) => [p.file, `/${p.slug}/`]));
const ABSOLUTE = /^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

let sourceDir = '.';
marked.use({
  walkTokens(token) {
    if (token.type !== 'link' || ABSOLUTE.test(token.href)) return;
    const [, path, rest = ''] = /^([^#?]*)(.*)$/.exec(token.href);
    const url = PAGE_URL.get(posix.normalize(posix.join(sourceDir, path)));
    if (url) token.href = url + rest;
  },
});

// Parse markdown that lives at `file`, so its relative links resolve from that
// file's own directory rather than from the repo root.
const render = (body, file) => {
  sourceDir = posix.dirname(file);
  return marked.parse(body);
};

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

const events = (await fetchEvents(CALENDAR_ID, { include: CALENDAR_INCLUDE }))
  .map((e) => ({ ...e, kind: 'event' }));

// One row per date: a session's notes, reading(s), excerpt(s) and calendar
// event(s) share a card.
const BUCKET = { meeting: 'meetings', reading: 'readings', excerpt: 'excerpts', event: 'events' };
const byDate = new Map();
for (const e of [...meetings, ...readings, ...events]) {
  if (!byDate.has(e.date)) byDate.set(e.date, { date: e.date, meetings: [], readings: [], excerpts: [], events: [] });
  byDate.get(e.date)[BUCKET[e.kind]].push(e);
}
for (const day of byDate.values()) day.events.sort((a, b) => a.start - b.start);

// A meeting time as written at build time, in the calendar's zone ("17:00 CET").
// The page's script rewrites it into each visitor's own time zone.
const clock = (e) => e.start.toLocaleTimeString('en-GB',
  { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: e.timeZone, timeZoneName: 'short' });
const today = new Date().toISOString().slice(0, 10);
const schedule = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));

// `base` is the relative path from the page being written back to the site root.
// `layout` is a class on <main>: 'single' for one centred card, 'split' for the
// index's main column plus sidebar.
const page = (title, main, { base = '', layout = 'single' } = {}) => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,600&display=swap">
<link rel="stylesheet" href="${base}style.css">
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a class="home" href="${base || '.'}"><span class="mark" aria-hidden="true">P</span>${escape(SITE_TITLE)}</a>
    <nav>
      <a href="${base}#schedule">Sessions</a>
    </nav>
  </div>
</header>
<main class="${layout}">
${main}
</main>
</body>
</html>
`;

const link = (e, text, cls) => `<a${cls ? ` class="${cls}"` : ''} href="${e.url}">${escape(text ?? e.title)}</a>`;

// Each session is a publication-style card. It leads with the full reading,
// falling back to an excerpt and then to the notes; whichever of those did not
// lead appears as a button underneath. A date known only from the calendar gets
// a placeholder title until a reading is added.
function row(day) {
  const lead = [day.readings, day.excerpts, day.meetings].find((g) => g.length) ?? [];
  const kind = lead[0]?.kind;
  const title = lead.length ? lead.map((e) => link(e)).join(' · ')
    : `<span class="tba">${day.date >= today ? 'Reading to be announced' : 'No reading posted'}</span>`;
  const times = day.events.filter((e) => e.start).map((e) =>
    `<time class="at" datetime="${e.start.toISOString()}">${clock(e)}</time>`);
  const actions = [
    ...(lead === day.meetings ? [] : day.meetings).map((m) => link(m, 'Meeting notes', 'btn')),
    ...(lead === day.excerpts ? [] : day.excerpts).map((r) => link(r, 'Excerpt', 'btn')),
    ...(kind === 'reading' ? lead.map((r) => link(r, 'Read full-text', 'btn primary')) : []),
  ];
  return `  <li class="card pub" id="session-${day.date}" data-date="${day.date}">
    <div class="pub-head">
      <div class="when"><time class="day" datetime="${day.date}">${longDate(day.date)}</time>${
        times.length ? ` <span class="times">${times.join(', ')}</span>` : ''}</div>
    </div>
    <h3 class="title">${title}</h3>${
      actions.length ? `\n    <div class="actions">${actions.join('')}</div>` : ''}
  </li>`;
}

// Buttondown's embed endpoint. It opens Buttondown's confirmation page in a new tab.
const NEWSLETTER = 'personhoodresearchgroup';
const PROTOCOL_INSTITUTE = 'https://protocol-institute-website.pages.dev/';
const GITHUB = 'https://github.com/ana0/Personhood-Research-Group';
const CALENDAR = subscribeUrl(CALENDAR_ID);

const sidebar = `<aside>
  <section class="card org">
    <h2>Part of</h2>
    <a class="org-name" href="${PROTOCOL_INSTITUTE}">
      <img src="assets/protocol-institute-logo.png" alt="" width="36" height="40">
      <span>The Protocol Institute</span>
    </a>
    <p>An independent organization researching, teaching and publishing on protocols: the rules and infrastructures that shape how people, organizations and systems interact.</p>
    <a href="${PROTOCOL_INSTITUTE}">Visit the Protocol Institute →</a>
  </section>
  <section class="card cal" hidden>
    <h2>Calendar</h2>
    <div class="cal-head">
      <button type="button" class="cal-nav" data-step="-1" aria-label="Previous month">‹</button>
      <span class="cal-month" aria-live="polite"></span>
      <button type="button" class="cal-nav" data-step="1" aria-label="Next month">›</button>
    </div>
    <table class="cal-grid"><thead><tr>${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<th>${d}</th>`).join('')}</tr></thead><tbody></tbody></table>
    <a class="btn" href="${CALENDAR}">Subscribe in Google Calendar</a>
  </section>
  <section class="card signup">
    <h2>Join the email list</h2>
    <p>Readings and call details for the next session.</p>
    <form action="https://buttondown.com/api/emails/embed-subscribe/${NEWSLETTER}" method="post" target="_blank">
      <label for="bd-email" class="visually-hidden">Email address</label>
      <input type="email" name="email" id="bd-email" placeholder="you@example.com" required>
      <input type="hidden" name="embed" value="1">
      <button type="submit" class="btn primary">Subscribe</button>
    </form>
  </section>${pages.length ? `
  <section class="card">
    <h2>Working documents</h2>
    <ul class="plain">
${pages.map((p) => `      <li><a href="${p.url}">${escape(p.title)}</a></li>`).join('\n')}
    </ul>
  </section>` : ''}
  <section class="card github">
    <h2>Contribute</h2>
    <p>Readings, notes and this site all live on GitHub. Suggest changes with a pull request.</p>
    <a class="btn" href="${GITHUB}"><svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>View on GitHub</a>
  </section>
</aside>`;

// The build can't know "today" (the site is only rebuilt on push), so the viewer's
// browser marks the soonest session that hasn't happened yet as the next meeting,
// and draws the sidebar calendar from the session cards' dates. Without JS both
// are simply absent (the calendar card stays hidden).
// Note: this is inside a template literal, so the client code avoids ${} and backticks.
const nextMeetingScript = `<script>
(() => {
  const iso = (d) => d.toLocaleDateString('en-CA');
  const today = iso(new Date());
  const sessions = [...document.querySelectorAll('.pub[data-date]')];
  const dates = new Set(sessions.map((li) => li.dataset.date));
  const next = sessions.filter((li) => li.dataset.date >= today).pop();
  if (next) {
    next.classList.add('next');
  }

  // Meeting times are written in the calendar's zone; show them in the visitor's.
  document.querySelectorAll('time.at').forEach((t) => {
    t.textContent = new Date(t.getAttribute('datetime'))
      .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
  });

  const cal = document.querySelector('.cal');
  if (!cal) return;
  const start = new Date((next ? next.dataset.date : today) + 'T00:00:00');
  let year = start.getFullYear(), month = start.getMonth();
  const label = cal.querySelector('.cal-month');
  const body = cal.querySelector('tbody');

  function draw() {
    label.textContent = new Date(year, month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const lead = new Date(year, month, 1).getDay(); // Sunday-first
    const days = new Date(year, month + 1, 0).getDate();
    let html = '';
    for (let i = 0; i < Math.ceil((lead + days) / 7) * 7; i++) {
      if (i % 7 === 0) html += '<tr>';
      const day = i - lead + 1;
      if (day < 1 || day > days) html += '<td></td>';
      else {
        const d = iso(new Date(year, month, day));
        const cls = [d === today && 'today', next && d === next.dataset.date && 'next'].filter(Boolean).join(' ');
        html += '<td' + (cls ? ' class="' + cls + '"' : '') + '>' +
          (dates.has(d) ? '<a href="#session-' + d + '" class="session">' + day + '</a>' : '<span>' + day + '</span>') + '</td>';
      }
      if (i % 7 === 6) html += '</tr>';
    }
    body.innerHTML = html;
  }
  cal.querySelectorAll('.cal-nav').forEach((b) => b.addEventListener('click', () => {
    month += Number(b.dataset.step);
    if (month < 0) { month = 11; year--; } else if (month > 11) { month = 0; year++; }
    draw();
  }));
  draw();
  cal.hidden = false;
})();
</script>`;

const scheduleHtml = schedule.length
  ? `<ul class="schedule">\n${schedule.map(row).join('\n')}\n</ul>`
  : '<p class="empty">Nothing scheduled yet.</p>';

// Write everything out.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Anything below a `<!-- hidden -->` line in the README stays in the repo (and on
// GitHub) but is left out of the site. The comment itself renders invisibly.
const HIDDEN = /^[ \t]*<!--\s*hidden\s*-->[ \t]*$/im;
let readme = '';
try {
  const text = readFileSync('README.md', 'utf8');
  const cut = HIDDEN.exec(text);
  readme = render(cut ? text.slice(0, cut.index) : text, 'README.md');
} catch {}

writeFileSync(join(OUT, 'index.html'),
  page(SITE_TITLE, `<div class="col">
<article class="card prose">
${readme}
</article>
<h2 id="schedule" class="section-title">Meetings &amp; readings</h2>
${scheduleHtml}
</div>
${sidebar}
${nextMeetingScript}`, { layout: 'split' }));

for (const m of meetings) {
  mkdirSync(join(OUT, m.url), { recursive: true });
  writeFileSync(join(OUT, m.url, 'index.html'),
    page(`${m.title} — ${SITE_TITLE}`,
      `<article class="card prose">
<div class="badges"><span class="badge">Meeting notes</span></div>
<p class="meta"><time datetime="${m.date}">${longDate(m.date)}</time></p>
${render(m.body, m.source)}
</article>`,
      { base: '../../' }));
}

for (const p of pages) {
  mkdirSync(join(OUT, p.url), { recursive: true });
  writeFileSync(join(OUT, p.url, 'index.html'),
    page(`${p.title} — ${SITE_TITLE}`,
      `<article class="card prose">\n${render(p.body, p.file)}\n</article>`, { base: '../' }));
}

if (readings.length) mkdirSync(join(OUT, 'readings'), { recursive: true });
for (const r of readings) cpSync(r.source, join(OUT, r.url));

cpSync('style.css', join(OUT, 'style.css'));
cpSync('assets', join(OUT, 'assets'), { recursive: true });

console.log(`built ${OUT}/: ${meetings.length} meeting note(s), ${readings.length} reading(s), ${pages.length} page(s), ${events.length} calendar event(s)`);
