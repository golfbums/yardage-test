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
| antler-creek | 18 | **PASS** | 24 yd | — (no golfer-confirmed truth yet) | `golf=hole` ref | Peyton CO (Colorado Springs). All 18 hole ways numbered by the volunteers; card from OpenGolfAPI (six tee sets, per-hole yardages, handicaps agree with the OSM tags). Worst hole 12 at 81 yd is a dogleg measured straight — expected. **OSM has fairways for only 5 of 18 holes**, so the Sketch look draws a corridor band on the other 13 until the photo mapper fills them in. Page: /antler-creek/. |

## Running totals

- Courses resolved: **3**
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
