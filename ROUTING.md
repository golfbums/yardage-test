# Numbering a golf course automatically

How to turn a bag of OpenStreetMap polygons into "this is the 7th hole, it plays 294
yards", with no human confirming anything — and how to know when to refuse.

This document exists because of a specific failure. An earlier pass at Buffalo Dunes
produced a course file whose holes were **rotated by nine**: the 10th hole was labelled
the 1st, and every yardage on the course belonged to a different hole. The chain of holes
was perfectly correct. Only the starting point was wrong, and nothing on screen looked
broken — the app confidently showed 391 yards to a green that was 612 away. It took a
human reading the published scorecard to catch it.

So the job splits into four things that fail independently, each with its own evidence
and its own veto.

---

## The four stages

| Stage | Question | Decided by | If it can't decide |
|---|---|---|---|
| 0 · Ref | Does OSM already say? | `ref` tags on greens / `golf=hole` ways | fall through to 1 |
| 1 · Pairing | Which tees play to which green? | hole centreline → fairway axis → cart path | **refuse** |
| 2 · Chain | What order are they played in? | shortest walk; two models, both built | — |
| 3 · Anchor | Which one is hole 1? | the scorecard's par sequence | **refuse** |

Stages 2 and 3 are decided together: the chain is built both ways and the scorecard says
which one it likes. See below.

Stage 4 is verification: every hole's mapped yardage is checked against the card, and
holes that disagree are flagged individually rather than silently shipped.

---

## Stage 0 — believe OSM when it has already done the work

If the greens carry `ref` tags forming a complete `1..N`, use them. Many mapped courses
do. Still check the implied par sequence against the card: a `ref` set that disagrees
with the card on more than ~20% of holes is a mis-tagged course, not a shortcut.

---

## Stage 1 — pairing: proximity does not work, and this is measurable

The tempting approach is "each tee belongs to its nearest green". It is wrong, and not
marginally. Measured across the three courses we have mapped by hand, here is where a
tee's **own** green ranks among all greens by distance from that tee:

| Course | rank of the correct green |
|---|---|
| Prairie Pines (9) | 2nd–8th |
| Pueblo CC (18) | 2nd–15th |
| Buffalo Dunes (18) | 1st–11th |

The reason is obvious once you see it: **your green is far away precisely because it is
the one you have to hit it that far to reach.** Fourteen other greens can sit closer to
your tee than your own. Proximity is not weak evidence here; it is close to
anti-correlated.

### When OSM has centrelines, they *are* the skeleton

If there's a `golf=hole` way per hole, don't treat it as one vote among several. A
centreline **is** the hole: one end is the tee, the other the green. So:

1. Match centrelines to greens 1:1 with the Hungarian algorithm, by the distance from the
   line's nearer end to the green. Globally, not greedily — two adjacent holes can each
   finish near the other's green, and only a joint assignment gets both right.
2. The other end of the line is the tee end.
3. Every tee box joins the hole whose **centreline it sits on**, within its first stretch.

That last step is fussier than it looks, and getting it wrong is what broke two of our
three test courses:

- Measuring to the tee **end** is too tight for a hole with a long tee stagger — Buffalo
  Dunes' 11th has six boxes spread over 134 yds — and simultaneously too loose on a
  packed course, where Pueblo's 1st tee sits within a hundred yards of the 3rd's tee end.
- Distance to the **line** alone is also not enough on a course whose holes run alongside
  each other. Score `distanceToLine + 0.5 × distanceAlongFromTeeEnd` and take the minimum;
  that says "on my line, near where my line starts", which is what a tee box is.
- Cap it: a tee never sits past ~60% of the hole.

Leaking one hole's tees onto its neighbour is not a cosmetic error. The stray tee becomes
the "back" tee, inflates that hole's length, flips its par, and poisons the anchor in
stage 3 — and it invents a short green-to-tee walk that sends the chain somewhere it
should never have gone.

### When there are no centrelines

Fall back to scoring every tee against every green, strongest evidence first:

1. **Fairway long axis.** A fairway is a long thin polygon. Its principal axis (PCA over
   the ring) runs tee→green. Require an elongation ratio above ~1.8, or the axis of a
   near-round blob is noise. Par 3s often have no fairway — they fall through.
2. **Cart path.** Sample points along the candidate tee→green line; if most sit within
   ~55 yds of a cart path, a path runs the length of that hole, which is what cart paths do.
3. **Card length.** Weak alone, but a candidate pair whose length matches no yardage on
   the scorecard is almost certainly wrong, and that rules pairs out cheaply.

Two things matter about how that evidence is used.

**"One end near the tee, the other near the green" is not enough.** A neighbouring hole's
fairway routinely satisfies it. Demand direction too: the run must point the way the hole
plays (within ~30°), start near the tee, finish near the green, and not detour — tee →
start → end → green barely longer than tee → green itself. On Prairie Pines the loose test
gave four wrong greens the same score as the right one.

**Score it as a quality, not a yes/no,** and pick the assignment globally (Hungarian). A
binary test leaves neighbouring holes tied, and a tie is broken by array order, which is to
say by luck. Your own fairway fits your own hole better than the next hole's does; a graded
score is what says so, and a global assignment is what stops two holes both taking the
other's green.

Finally, **tees really can be shared**: Prairie Pines' 2nd and 6th leave from the same box,
nought yards apart. A green left orphaned by the assignment may share the tee that scores
best for it, marked `shared-tee`.

**If a hole is paired on length alone, say so.** The router marks those and drops its
confidence. A course with no fairways, cart paths or centrelines in OSM cannot be paired
by this method, and the right answer is to refuse and go map those features first.

---

## Stage 2 — chain: a course is two paths, not one loop

The holes form a chain because **the green of hole N sits next to the tee of hole N+1**.
Measured green→next-tee walks on our three courses: median 51–74 yds, and almost all
under 100. That is a strong signal.

The obvious move is to find the shortest Hamiltonian cycle over the holes. On Prairie
Pines and Buffalo Dunes this recovers the true routing exactly, 18 of 18. **On Pueblo
Country Club it fails**, and the failure is instructive: it jumps from the 7th green
straight to the 15th tee, because those happen to sit close together.

The real structure is not one cheap loop. Both nines **start and end at the clubhouse**,
which makes 9→10 and 18→1 long by design — 206 and 263 yds at Pueblo, against a median
of 51. A shortest-cycle solver will always try to avoid paying those, and it does so by
inventing a shortcut somewhere else.

**The fix: add the clubhouse as a depot, duplicated once per nine.** Solve the minimum
Hamiltonian cycle over `holes + nines` nodes where the depot copies are the clubhouse and
depot→depot is forbidden. The solution falls out as two nines that each leave and return
to the clubhouse.

**And force each nine to hold exactly nine holes.** Left free, the solver split Pueblo
into legs of sixteen and two — paying for one long walk beats paying for two. Golf does
not work that way. The constraint costs nothing to add (the visited-mask already says
whether the second depot has been used, so "you may only close a nine on the ninth hole"
is a one-line check) and it removes the cheap shortcut the solver was reaching for.

Held–Karp is exact and takes about two seconds at n=20. Do not use a heuristic; the whole
point is that the greedy answer is the one that got us into trouble.

**Clubhouse.** Use `building=clubhouse` / `amenity=clubhouse` / `golf=clubhouse` when
tagged. When it isn't, infer it as the node with the tightest knot of other tees and greens
around it — holes 1, 9, 10 and 18 all crowd the clubhouse.

**But don't bet the routing on that guess.** Hanging a hard nine-and-nine constraint off an
inferred point is worse than not constraining at all: it is right for Pueblo, whose
clubhouse OSM actually carries, and it wrecks Buffalo Dunes, whose clubhouse we can only
estimate and which the plain unconstrained loop gets exactly right.

So **build both chains and let the scorecard choose.** Run stage 3 against each candidate
and keep whichever matches the card's par sequence best, breaking ties on the bigger
margin. The card arbitrates everywhere else in this pipeline; there is no reason to bet the
routing on a guess here instead. With that, all three courses recover exactly:

```
Prairie Pines  9/9   Pueblo CC  18/18   Buffalo Dunes  18/18
```

**Cart paths do this job too, independently.** If you compute the walk as network distance
along the cart-path graph instead of straight-line, Pueblo's 7th-green-to-15th-tee
shortcut simply doesn't exist as an edge, because there is no path between them. Two
different fixes for the same failure is worth having; use both.

---

## Stage 3 — anchor: this is the one that bit us

After stage 2 you have a ring of holes in the right order and **no idea which one is the
first**. Rotating the ring by nine turns the back nine into the front, and every hole on
the course silently takes on someone else's yardage. That is exactly the Buffalo Dunes bug
(`repaired: { rotation: 9, from: "published scorecard" }`).

There are only `2N` possibilities — N rotations × 2 directions, 36 for an 18-hole course.
So **score all of them against the published scorecard and take the winner.**

The workhorse is the **par sequence**. A course's run of 3s and 5s is close to a
fingerprint. Derive each hole's par from its mapped length (`<250` → 3, `>460` → 5, else
4) and count mismatches against the card. Results:

| Course | best | runner-up | correct? |
|---|---|---|---|
| Prairie Pines | 0 mismatches | 2 | yes |
| Pueblo CC | 1 | 7 | yes |
| Buffalo Dunes | 2 | 6 | yes |

Unique winner, clear margin, every time — including on the course that was previously got
wrong. Where the card also lists yardages, score mean absolute error too; on Buffalo Dunes
that separated 46 yds from 87.

**The margin is the confidence, and it is a veto.** Require the winner to beat the
runner-up by at least 2 par mismatches, or 15 yds of mean error. If it doesn't, the data
genuinely cannot tell you where hole 1 is — **refuse and flag the course**. A flagged
course costs somebody a phone call to the pro shop. A silently rotated one costs every
yardage on it, and nobody notices until a member is 200 yards from where the app says.

**Other anchors, if you want belt and braces:** the clubhouse (tee 1, green 9, tee 10 and
green 18 are the four holes nearest it); a `golf=practice` putting green, which sits by the
1st tee; the driving range, usually by 1 or 10.

---

## Stage 4 — verify every hole, and publish what didn't check out

Per hole, compare mapped yardage against the card. Tolerance: the greater of 25 yds or
12%. Holes outside it are not necessarily wrong — Buffalo Dunes has seven greens that were
rebuilt after the aerial imagery was flown, so the map is right about where the old green
was and useless about the new one. Record them:

```js
warning: "11 of 18 holes check out against the current scorecard. 7 do not — those
          greens were rebuilt after this aerial was flown …"
```

Confidence, overall: `high` if ≥80% of checkable holes verify, `medium` at ≥50%, `low`
below, and `refused` if stage 1, 2 or 3 declined to decide.

---

## Running it

```bash
# 1. pull OSM — cart paths and fairways included, they are load-bearing
node tools/overpass.js "Prairie Pines" 37.5790 -101.7395 > /tmp/pp-osm.json

# 2. route it, against the club's published scorecard
node -e '
  const {route} = require("./tools/route");
  const osm  = require("/tmp/pp-osm.json");
  const card = require("/tmp/pp-card.json");   // [{hole,par,yds,handicap}]
  console.log(JSON.stringify(route(osm, card), null, 2));
'

# 3. never ship a change to the router without this
node tools/route.test.js
```

The scorecard is not optional. It is the only outside evidence in the whole pipeline, and
stages 3 and 4 both lean on it. Nearly every club posts par and yardages; where one
doesn't, par alone is enough to anchor, and the course ships as `medium` confidence with
its yardages unverified.

## What is and isn't proven

`tools/route.test.js` strips our three hand-checked courses back to an unlabelled, shuffled
bag of polygons and asks the router to put the numbers back.

**Proven — 45 of 45 holes numbered correctly.**

| | numbering | tee boxes clean |
|---|---|---|
| Prairie Pines | 9/9 | 9/9 |
| Pueblo CC | 18/18 | 15/18 |
| Buffalo Dunes | 18/18 | 16/18 |

Those runs supply hole centrelines, taken from each course's own mapped `line` — which is
exactly the geometry OSM carries as a `golf=hole` way, so it is real data rather than a
shape invented to suit the test. The handful of holes with an untidy tee box have the right
number on the right green; a stray forward tee shifts one yardage, where a wrong number
moves every yardage on the course.

The suite also checks the router **refuses** when handed tees and greens alone, with no
centrelines, fairways or cart paths. It does.

**Not proven.** The fairway-axis and cart-path evidence paths, and the cart-path walking
graph, are implemented and never exercised against real data — no mapped `course.js`
carries fairway rings or cart paths, and the cloud session's network policy blocks
Overpass. The first course mapped from a live pull should have its OSM saved as a fixture
and added here. Until then, treat a course routed purely on fairways as needing a look.
