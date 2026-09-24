---
name: map-a-course
description: Map a golf course into a Golf Bums course.js — pull OpenStreetMap geometry, work out which tees play to which greens, number the holes correctly against the club's published scorecard, and verify every yardage. Use whenever Seth names a course to add ("let's do Buffalo Dunes", "map Sand Creek", "add the course at X"), when a mapped course's hole numbers or yardages look wrong, or when a course file needs rebuilding. Runs without human confirmation, and refuses rather than guessing when the evidence is thin.
---

# Mapping a course

Read `ROUTING.md` in the repo root before starting. It carries the algorithm, the measured
evidence behind each stage, and the reasoning for the thresholds. This file is the
procedure.

**The rule that matters: never publish a course the router refused.** An earlier pass
shipped Buffalo Dunes with every hole rotated by nine — chain correct, starting point
wrong, and the app confidently gave members yardages belonging to a different hole. A
course flagged for review costs one phone call to the pro shop. A silently mis-numbered
one costs every yardage on it, and nobody notices until someone is two hundred yards from
where the app says they are.

## 1 · Find the course

Get its centre lat/lon. Confirm it's the right club — small-town courses share names, and
"Prairie Pines" exists in more than one state.

## 2 · Get the scorecard first, not last

Before touching OSM, find the club's published scorecard: par per hole, yardage per hole
per tee set, and stroke index if it's there. Club website, the state golf association, or
a course-directory listing. Write it to `/tmp/<key>-card.json`:

```json
{ "name": "Prairie Pines", "tee": "Red",
  "holes": [ {"hole":1,"par":4,"yds":289,"handicap":7}, ... ] }
```

Do this first because the scorecard is the only outside evidence in the pipeline — stage 3
anchors on it and stage 4 verifies against it. Without at least par per hole there is no
way to know where hole 1 is, and the router will refuse. Yardages are strongly preferred;
par alone still anchors, but ships at `medium` confidence.

If the card and OSM disagree on hole count, trust the card and say so — OSM may be missing
a green or carrying a practice hole.

## 3 · Pull OSM, cart paths included

```bash
node tools/overpass.js "<Name>" <lat> <lon> [radius_m] > /tmp/<key>-osm.json
```

Check the counts it prints on stderr. **If fairways, cart paths and `golf=hole`
centrelines are all zero, stop.** Tees and greens alone cannot be paired — a tee's own
green ranks as far as 15th-nearest, so proximity is close to anti-correlated (ROUTING.md
has the measurements). Widen the radius; if they're genuinely not in OSM, say so and
either map them in OSM first or fall back to `map/index.html` for a human pass.

A `golf=hole` way per hole is the jackpot: the router uses centrelines as the skeleton and
gets all 45 of our known holes right from them. Fairways and cart paths are the fallback,
and that path has never been run against real OSM data — if a course routes on those
alone, say so in your report and look at the result yourself before building anything.

If every Overpass mirror fails in a cloud session, it's the environment's network policy
blocking `overpass-api.de` — tell Seth to add it under the environment's Network access,
or run this from the desktop.

## 4 · Route it

```bash
node -e '
  const {route}=require("./tools/route");
  console.log(JSON.stringify(route(require("/tmp/<key>-osm.json"),
                                   require("/tmp/<key>-card.json")),null,2));
' > /tmp/<key>-routed.json
```

Read `confidence`, `review[]` and `diagnostics.anchor` before anything else.

- `confidence: "refused"` → **do not build a course file.** Report what's missing.
- `diagnostics.anchor.decided: false` → hole 1 isn't pinned. Get a better scorecard.
- `anchor.parGap` of 1, or `ydGap` under 15 → too close to call. Same answer.
- Holes listing `evidence: ["card-length"]` alone → paired on length with nothing
  confirming it. Name those holes to Seth.

A healthy 18-hole run looks like `parGap ≥ 2`, `verified ≥ 14/18`, and every hole carrying
`centreline`, `fairway` or `cartpath` evidence.

`diagnostics.legs` should read `[9,9]` on an 18-hole course and `diagnostics.chainKind`
tells you which model won — `depot` (both nines hung off the clubhouse) or `loop` (plain
cheapest cycle). Either is fine; the scorecard picked it. `legs` of anything else means
the hole count or the pairing is wrong, whatever the confidence says.

## 5 · Build the course file

Match the existing shape exactly — `prairie-pines/course.js` is the reference:

```js
window.COURSE={"name":…,"source":…,"par":…,"cardTee":…,"holes":[{
  "hole":1,"par":4,"handicap":7,
  "line":[tee,…bends…,green],
  "green":{"ring":…,"center":…,"front":…,"back":…,"depthYds":…,"elev":…},
  "tees":[{"center":…,"ring":…,"name":"Red","yds":289,"elev":…}],
  "fairways":[…],"bunkers":[…],"water":[…],"verified":true}]}
```

- **`line`** — insert dogleg bends from the fairway's shape where the fairway turns. A
  straight tee→green line reads short on a dogleg, which is wrong on exactly the holes
  where a member most needs the number.
- **`front`/`back`** — the green ring's extreme points along the line of play, not its
  bounding box.
- **`elev`** — USGS EPQS (`epqs.nationalmap.gov/v1/json`), per green and per tee.
- **`verified`** — straight from stage 4, per hole. Never blanket-true it.
- **`warning`** — when holes fail verification, write the plain-English reason, the way
  Buffalo Dunes does. Seth reads these; write them for him, not for a log.
- **`source`** — credit OSM (ODbL) and USGS.

Then copy an existing `index.html` alongside it and change only the `<title>` and the
name in the header — the viewer is identical across courses.

## 6 · Check it

```bash
node --check <key>/course.js
node tools/route.test.js        # must stay at 45/45 if you touched the router
```

Then eyeball it: hole 1's tee should be near the clubhouse, 9's green should come back to
it, and the yardages should read like a scorecard rather than a random sequence.

## 7 · Report in five lines

Course, holes mapped, confidence, how many verified against the card, and any hole you'd
want a human to look at. If you refused, say what would unblock it — usually a scorecard
with yardages, or fairways that nobody has drawn in OSM yet.

## When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Whole course off by a constant | anchor picked the wrong rotation | check `parGap`; get yardages on the card |
| Front and back nine swapped | rotation of exactly 9 | same — this is the Buffalo Dunes bug |
| Two holes' tees and greens crossed | pairing had only length to go on | need fairways or cart paths in OSM |
| One hole far too long | a shortcut across the property | cart-path network distance kills these |
| Several holes short by 20–40 yds | doglegs mapped as straight lines | add bends to `line` from the fairway |
| A few holes off by a lot, rest fine | greens rebuilt since the aerial | mark `verified:false`, write a `warning` |
