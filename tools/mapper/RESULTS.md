# Course mapper — results ledger

One line per course, appended as they're mapped. `node score.js` reads the same data and
prints the running totals.

**The number that decides whether this can run unattended is not accuracy — it's whether
it ever says PASS while being wrong.** That must stay at zero. A course it refuses is a
course a golfer taps in two minutes. A course it gets confidently wrong costs trust.

| course | holes | verdict | median err | vs confirmed truth | anchored by | notes |
|---|---|---|---|---|---|---|
| prairie-pines | 9 | **PASS** | 21 yd | greens 9/9, holes 9/9 | fairway `ref` | Johnson City KS. Routing confirmed by ogbum in the tap-mapper. OSM had the hole numbers on the fairways. Cart paths settled the par-3 tee. |
| buffalo-dunes | 18 | **FAIL** | 84 yd | — | `golf=hole` ref | Garden City KS. Correctly refused: the OSM data is the **pre-2021** course. Renovated 2021–26, nines swapped, three greens moved. Matches the old card at 21 yd median, in order. Needs fresher aerial before it can pass. |
| antler-creek | 18 | **PASS** | 24 yd | — (no golfer-confirmed truth yet) | `golf=hole` ref | Peyton CO (Colorado Springs). All 18 hole ways numbered by the volunteers; card from OpenGolfAPI (six tee sets, per-hole yardages, handicaps agree with the OSM tags). Worst hole 12 at 81 yd is a dogleg measured straight — expected. OSM had fairways for only 5 of 18 holes; **the fairways are now read from the free USGS NAIP photo** (`fairways.py`): all 14 par 4/5 holes outlined on the strict pass, par 3s carry none, and the four volunteer polygons were replaced by the photo's (they overlapped 46–56% because the volunteers had drawn fragments). Hole 16 is a dogleg whose OSM hole line is straight, so the volunteer's polygon anchored the search there. Page: /antler-creek/. |
| kings-deer | 18 | **PASS** (card-fitted) | 2 yd | — (no golfer-confirmed truth yet) | 4-colour card fit + photo read + cart paths | Monument CO. **OSM has no hole numbers at all**: 72 tee pads, 19 greens (one is the practice green), so route.js can't start. Tier 2 (course-mapper PROCESS 7i): pads clustered into 29 complexes, every complex × green fitted against all four card colours, then confirmed on the NAIP photo and the cart paths. The 2 yd median is **circular**, because the card chose the pairing, so this row cannot count toward accuracy until a round is played with the page open. Holes 1/7/8 read 18/51/20 short straight-line (doglegs). `routing.json` now lists each hole's own pads (`tees`), because the 140 m rule pulled neighbours' pads in on this compact course. Fairways: 13/13 par 4/5 holes on the strict pass; the 5/8 and 3/4 outlines touch. Page: /kings-deer/. |

## Running totals

- Courses resolved: **4**
- With a golfer-confirmed routing to check against: **1**
- Holes correct where truth exists: **9/9**
- **Said PASS while wrong: 0** ✓
- Confirmed courses still needed before the accuracy number means anything: **19** (Antler Creek is Seth's home turf — a round there with the page open is the cheapest confirmation)

## What each verdict cost to produce

Nothing but time. Every input is free and unlimited: OpenStreetMap geometry (ODbL,
attribution only), USGS elevation (public domain), published scorecards (read, not
scraped at volume). No vendor, no per-course fee, no subscription.

## Known limits, honestly

- **One confirmed course is not a test set.** The current settings were arrived at while
  working on Prairie Pines, so they may be fitted to it. Twenty courses before trusting
  the constants.
- **Stale aerials are a first-class problem, not an edge case.** Buffalo Dunes was
  rebuilt over five years; NAIP imagery is reflown every two to three. Store the imagery
  date alongside every course and re-check anything whose card drifts.
- **Courses with no cart paths mapped** lose the signal that settles par-3 tees. The
  fallback is straight-line distance, which is weaker.
- **Courses with no published per-hole card** can't be verified at all. They should go
  straight to the tap-mapper rather than be published unchecked.

## Fairways from the photo (`fairways.py`)

The volunteers rarely draw fairways, so they come from the free USGS NAIP photo (4 bands,
0.3 m, reflown every 2–3 years), never from Google, Apple, Bing or Esri. For every par 4/5:
keep the living, even-textured turf (NDVI above .28, green over red, texture under .055 in
an 11-px window), inside 50 m of the hole line or 35 m of a volunteer's fairway polygon,
cut the green and the tees out with a 3 m collar, keep the mown band the hole line actually
runs through (a fifth of its samples, or a big band it crosses), soften, trace, simplify at
2 m. If the strict pass finds nothing, one looser pass (NDVI .20, texture .075) for a dry,
patchy fairway. Par 3s get no fairway. The report beside each course says which pass each
hole took and how much it overlaps a volunteer's polygon where one existed.

    python3 tools/mapper/fairways.py courses/<slug>/course.json courses/<slug>/course.json courses/<slug>/naip

Known limits: a parkland course with irrigated, short-mown rough gives weaker contrast (the
texture and the lidar's ground roughness are the next lever); the photo is a year or two
old; the line-corridor rule needs a dogleg vertex or a volunteer polygon to reach a landing
area far off a straight hole line.
