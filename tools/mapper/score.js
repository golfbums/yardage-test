// The scoreboard. Run it after any change to the resolver.
//
// Two numbers matter and they are different:
//   ACCURACY  — on courses where a golfer has confirmed the routing (truth.json),
//               how many holes does the resolver get right on its own?
//   HONESTY   — when it is wrong, does it say so? A resolver that fails loudly is
//               safe to run on thousands of courses. One that passes while wrong is not.
//
// The second number is the one that decides whether this can run unattended.
//
//   node score.js            report on every course
//   node score.js --brief    one line per course

const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, 'courses');
const brief = process.argv.includes('--brief');
const keys = fs.readdirSync(dir).filter(k => fs.existsSync(path.join(dir, k, 'routing.json')));

const rows = [];
for (const key of keys) {
  const cd = path.join(dir, key);
  const r = JSON.parse(fs.readFileSync(path.join(cd, 'routing.json'), 'utf8'));
  const meta = fs.existsSync(path.join(cd, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(cd, 'meta.json'), 'utf8')) : {};
  const truthFile = path.join(cd, 'truth.json');
  let holes = null, greens = null, n = r.holes.length;
  if (fs.existsSync(truthFile)) {
    const t = JSON.parse(fs.readFileSync(truthFile, 'utf8')).holes.filter(Boolean);
    holes = 0; greens = 0;
    t.forEach((x, i) => {
      const y = r.holes[i];
      if (y && y.green === x.green) greens++;
      if (y && y.green === x.green && y.tee === x.tee) holes++;
    });
    n = t.length;
  }
  rows.push({ key, n, pass: r.pass, med: r.medianErr, source: r.source, holes, greens,
    confirmed: fs.existsSync(truthFile), teeSet: r.teeSet,
    numbered: meta.holeNumbersOn ? Math.max(meta.holeNumbersOn.holeWay || 0, meta.holeNumbersOn.fairway || 0) : null });
}

if (brief) {
  rows.forEach(r => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.key.padEnd(22)} ${String(r.n).padStart(2)}h  median ${String(r.med).padStart(3)}yd  ${r.confirmed ? `${r.holes}/${r.n} vs truth` : 'unconfirmed'}`));
} else {
  console.log('\nCOURSE                 HOLES  VERDICT  MEDIAN  vs CONFIRMED TRUTH        ANCHORED BY');
  console.log('─'.repeat(92));
  rows.forEach(r => console.log(
    r.key.padEnd(22) + String(r.n).padStart(5) + '  ' +
    (r.pass ? 'PASS   ' : 'FAIL   ').padEnd(9) +
    (r.med + 'yd').padStart(6) + '  ' +
    (r.confirmed ? `greens ${r.greens}/${r.n}, holes ${r.holes}/${r.n}`.padEnd(26) : '—'.padEnd(26)) +
    (r.source || '')));
}

// ── the two headline numbers ────────────────────────────────────────────────
const conf = rows.filter(r => r.confirmed);
const totH = conf.reduce((s, r) => s + r.n, 0), gotH = conf.reduce((s, r) => s + r.holes, 0), gotG = conf.reduce((s, r) => s + r.greens, 0);

// Honesty: of the confirmed courses, did the verdict match reality?
const honest = conf.filter(r => (r.holes === r.n) === r.pass).length;
const dangerous = conf.filter(r => r.pass && r.holes < r.n);

console.log('\n' + '═'.repeat(92));
console.log(`COURSES          ${rows.length} resolved, ${conf.length} with a golfer-confirmed routing to check against`);
if (conf.length) {
  console.log(`ACCURACY         greens ${gotG}/${totH} (${Math.round(gotG / totH * 100)}%)   complete holes ${gotH}/${totH} (${Math.round(gotH / totH * 100)}%)`);
  console.log(`HONESTY          verdict matched reality on ${honest}/${conf.length} courses`);
  if (dangerous.length) {
    console.log(`\n⚠  SAID PASS WHILE WRONG — this is the number that must stay at zero:`);
    dangerous.forEach(r => console.log(`     ${r.key}: passed but only ${r.holes}/${r.n} holes correct`));
  } else {
    console.log(`                 no course passed while wrong ✓`);
  }
}
console.log(`\nREADY TO SCALE?  ${conf.length < 20 ? `not yet — ${20 - conf.length} more confirmed courses needed before the numbers mean anything`
  : dangerous.length ? 'NO — it passed while wrong; fix that before anything else'
  : gotH / totH >= 0.95 ? 'yes on this evidence — spot-check a fresh course to be sure'
  : `not yet — ${Math.round(gotH / totH * 100)}% of holes correct, want 95%+`}`);
console.log('═'.repeat(92) + '\n');
