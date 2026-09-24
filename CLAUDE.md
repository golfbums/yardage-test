# yardage-test — GPS and course mapping for Golf Bums

The GPS side of Golf Bums, kept separate from the app prototype in
`golfbums/fantasy-app-prototype`. Everything here is static HTML published straight to
GitHub Pages at **golfbums.github.io/yardage-test** — no build step, so Seth can open any
of it on his phone on the course.

Read `CLAUDE.md` in the prototype repo for who Seth is, the brand palette, the design
principles and how to work with him. The same taste rules apply here; the same
**hard rule** applies too — the app never handles money.

## What's in here

| Path | What it is |
|---|---|
| `index.html` | **Yardage test.** Tap to plant a green, it rotates the hole so the green is at the top and puts the yards on the line. GPS smoothing, jitter readout, USGS elevation, plays-like. |
| `<course>/index.html` | **Course viewer** — the real thing, reading `course.js`. Identical across courses bar the title. |
| `<course>/course.js` | The mapped course: `window.COURSE = {…}`. |
| `map/index.html` | Manual mapper — tap tee then green, hole by hole, emits JSON. The fallback when automatic routing refuses. |
| `map/<course>.json` | Raw OSM tee and green candidates for the mapper. |
| `tools/route.js` | **Automatic hole numbering.** Pairs tees to greens, chains the holes, anchors hole 1 against the scorecard. |
| `tools/overpass.js` | Pulls a course out of OpenStreetMap in the shape `route.js` wants. |
| `tools/geo.js` | Shared geometry — distances in yards, PCA axes, cart-path helpers. |
| `tools/route.test.js` | Regression test over our three hand-checked courses. **45/45 or it's broken.** |
| `ROUTING.md` | The algorithm, the evidence behind it, and why each threshold is what it is. |

Courses mapped so far: **Prairie Pines** (Johnson City KS, 9 holes, routing confirmed by a
member), **Buffalo Dunes** (18), **Pueblo Country Club** (18).

## Adding a course

Use the `map-a-course` skill — it's the whole procedure. Read `ROUTING.md` first.

## The mistake not to repeat

Buffalo Dunes shipped with every hole **rotated by nine** — the 10th hole labelled the 1st.
The chain of holes was correct; only the starting point was wrong, and nothing looked
broken on screen. The app gave members yardages belonging to a different hole, and it took
a human reading the published scorecard to catch it. The file still records it:

```js
repaired: { rotation: 9, from: "published scorecard", unverified: [2,3,4,10,11,12,13] }
```

That is why `route.js` treats pairing, chaining and anchoring as three separate decisions,
each with a veto, and why it **refuses rather than guesses**. Never publish a course the
router refused, and never blanket-set `verified: true`.

Two things fall out of that, worth knowing before you change anything:

- **Proximity cannot pair a tee with its green.** Measured on all three courses, a tee's
  own green ranks 2nd to 15th nearest — your green is far away precisely because it's the
  one you hit that far. Pairing needs the `golf=hole` centreline, the fairway's long axis,
  or a cart path.
- **A course is two paths, not one loop.** Both nines start and end at the clubhouse, so
  9→10 and 18→1 are long by design. A plain shortest-cycle solver avoids paying for them
  by inventing a shortcut elsewhere — it did exactly that at Pueblo CC, jumping the 7th
  green to the 15th tee. Hang both nines off a clubhouse depot, and force each nine to
  hold nine holes or it will split them 16 and 2.
- **Don't build a hard constraint on a guessed clubhouse.** Where OSM doesn't tag one, the
  depot model is worse than no model — it wrecks Buffalo Dunes, which the plain loop gets
  exactly right. Build both chains and let the scorecard pick. `route.js` does this.
- **`golf=hole` centrelines are the skeleton, not a vote.** A centreline *is* the hole. All
  45 known holes come back correctly from them. Fairway and cart-path evidence is the
  fallback and has never been tested against real OSM.

## Working here

- Static files, no build, no package.json. `node --check` anything you edit.
- `node tools/route.test.js` before any commit that touches `tools/`.
- Overpass is blocked by the network policy in some Claude Code cloud environments. If
  every mirror fails, that's why — add `overpass-api.de` to the environment's allowed
  domains, or run the pull from the desktop.
- Commit and push after every change, so the desktop and cloud copies never drift.
