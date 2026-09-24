#!/usr/bin/env python3
"""Outline the fairways from the free USGS NAIP photo (4 bands, 0.3 m).

    python3 tools/mapper/fairways.py <course.json> <out.json> [cache dir]

For every hole with a par of 4 or more: fetch the photo around the hole, keep the living,
even-textured turf (NDVI + texture), inside 50 m of the hole line, cut the green and the
tees out, keep the mown band the hole line actually runs through, smooth it and trace it.
Par 3s get no fairway. Never traces Google / Apple / Bing / Esri.
Output: the course record with `fairways` replaced on every par 4/5, plus a report.
"""
import json, os, subprocess, sys, math
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from skimage import measure

NAIP = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage"
MPP = 0.3            # metres per pixel we ask for
MARGIN = 60          # m around the hole
CORRIDOR = 50        # m either side of the hole line that can count as this hole's fairway
NDVI_MIN, TEXTURE_MAX = 0.28, 0.055
MIN_M2 = 400         # smaller mown patches are aprons and paths, not fairway

def fetch(bbox, w, h, path):
    if os.path.exists(path) and os.path.getsize(path) > 1000: return
    url = f"{NAIP}?bbox={bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}&bboxSR=4326&imageSR=4326&size={w},{h}&format=tiff&pixelType=U8&noData=0&interpolation=RSP_BilinearInterpolation&f=image"
    subprocess.run(["curl", "-sS", "-o", path, url], check=True)

def seg_dist(px, py, ax, ay, bx, by):
    """distance from every pixel to segment ab (all in pixel units)"""
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = np.clip(((px - ax) * dx + (py - ay) * dy) / (L2 or 1), 0, 1)
    return np.hypot(px - (ax + t * dx), py - (ay + t * dy))

def outline(hole, cache):
    pts = list(hole["line"]) + [t["center"] for t in hole["tees"]] + hole["green"]["ring"]
    lats = [p["lat"] for p in pts]; lons = [p["lon"] for p in pts]
    lat0 = (min(lats) + max(lats)) / 2
    mlat = 111_100.0; mlon = 111_100.0 * math.cos(math.radians(lat0))
    dlat, dlon = MARGIN / mlat, MARGIN / mlon
    Y0, Y1, X0, X1 = min(lats) - dlat, max(lats) + dlat, min(lons) - dlon, max(lons) + dlon
    W = int(round((X1 - X0) * mlon / MPP)); H = int(round((Y1 - Y0) * mlat / MPP))
    tif = os.path.join(cache, f"hole{hole['hole']}.tif")
    fetch((X0, Y0, X1, Y1), W, H, tif)
    a = np.array(Image.open(tif)).astype(np.float32)
    if a.ndim != 3 or a.shape[2] < 4: raise SystemExit(f"hole {hole['hole']}: photo is not 4-band")
    H, W = a.shape[:2]
    def px(p): return ((p["lon"] - X0) / (X1 - X0) * W, (Y1 - p["lat"]) / (Y1 - Y0) * H)
    def ll(x, y): return (Y1 - (y / H) * (Y1 - Y0), X0 + (x / W) * (X1 - X0))
    R, G, B, N = [a[..., i] for i in range(4)]
    ndvi = (N - R) / (N + R + 1e-6)
    tex = np.sqrt(np.maximum(ndi.uniform_filter(ndvi * ndvi, 11) - ndi.uniform_filter(ndvi, 11) ** 2, 0))
    return _finish(hole, a, ndvi, tex, W, H, px, ll, NDVI_MIN, TEXTURE_MAX, 13, "strict") \
        or _finish(hole, a, ndvi, tex, W, H, px, ll, 0.20, 0.075, 19, "loose")   # a dry, patchy fairway: one looser pass

def _finish(hole, a, ndvi, tex, W, H, px, ll, ndvi_min, tex_max, close, pass_name):
    R, G = a[..., 0], a[..., 1]
    mask = (ndvi > ndvi_min) & (G >= R * 1.05) & (tex < tex_max)
    mask = ndi.binary_opening(mask, structure=np.ones((9, 9)))     # slivers under ~2.7 m
    mask = ndi.binary_closing(mask, structure=np.ones((close, close)))   # divots, cart-path gaps
    # only inside the hole's own corridor
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    line = [px(p) for p in hole["line"]]
    d = np.full((H, W), np.inf, np.float32)
    for (ax, ay), (bx, by) in zip(line[:-1], line[1:]): d = np.minimum(d, seg_dist(xx, yy, ax, ay, bx, by))
    near = d < CORRIDOR / MPP
    # a volunteer's fairway polygon anchors a dogleg the straight hole line misses (35 m around it)
    osm = hole.get("osmFairways") or []
    if osm:
        oimg = Image.new("L", (W, H), 0); od = ImageDraw.Draw(oimg)
        for r in osm: od.polygon([px(p) for p in r], fill=255)
        osm_mask = ndi.binary_dilation(np.array(oimg) > 0, structure=np.ones((int(2 * 35 / MPP) + 1,) * 2))
        near |= osm_mask
    mask &= near
    # cut the green and the tees, with a 3 m collar
    cut = Image.new("L", (W, H), 0); dr = ImageDraw.Draw(cut)
    dr.polygon([px(p) for p in hole["green"]["ring"]], fill=255)
    for t in hole["tees"]:
        if t.get("ring"): dr.polygon([px(p) for p in t["ring"]], fill=255)
    mask &= ~ndi.binary_dilation(np.array(cut) > 0, structure=np.ones((21, 21)))
    lab, n = ndi.label(mask)
    # the band the hole line runs through, sampled every 1 m from 60 m past the tee
    samples = []
    for (ax, ay), (bx, by) in zip(line[:-1], line[1:]):
        k = max(1, int(math.hypot(bx - ax, by - ay) * MPP))
        samples += [(ax + (bx - ax) * t / k, ay + (by - ay) * t / k) for t in range(k + 1)]
    samples = samples[MARGIN:]
    hits = np.bincount([lab[int(y), int(x)] for x, y in samples if 0 <= int(y) < H and 0 <= int(x) < W], minlength=n + 1)
    hits[0] = 0
    keep = [i for i in range(1, n + 1) if hits[i] >= 0.2 * len(samples) or (hits[i] >= 30 and ndi.sum(mask, lab, i) * MPP * MPP > 2500)]
    if osm:   # and any band that fills at least half of a volunteer's polygon
        core = np.array(oimg) > 0
        for i in range(1, n + 1):
            if i not in keep and ((lab == i) & core).sum() >= 0.5 * core.sum(): keep.append(i)
    fw = np.isin(lab, keep)
    fw = ndi.gaussian_filter(fw.astype(np.float32), 3) > 0.5           # soften the pixel steps
    lab2, n2 = ndi.label(fw)
    polys, m2 = [], 0
    for i in range(1, n2 + 1):
        comp = lab2 == i; area = comp.sum() * MPP * MPP
        if area < MIN_M2: continue
        cs = measure.find_contours(np.pad(comp, 1).astype(float), 0.5)
        ring = measure.approximate_polygon(max(cs, key=len), tolerance=2.0 / MPP)
        polys.append([{"lat": round(la, 6), "lon": round(lo, 6)} for la, lo in (ll(x - 1, y - 1) for y, x in ring)])
        m2 += area
    if not polys: return None
    return polys, m2, {"pass": pass_name, "components_on_line": {int(i): int(hits[i]) for i in np.nonzero(hits)[0]}, "kept": keep, "samples": len(samples)}

def iou(a, b, hole):
    """overlap between two lat/lon rings, on a 1 m grid"""
    pts = [p for r in a + b for p in r]
    lats = [p["lat"] for p in pts]; lons = [p["lon"] for p in pts]
    lat0 = sum(lats) / len(lats); mlat = 111_100.0; mlon = mlat * math.cos(math.radians(lat0))
    W = int((max(lons) - min(lons)) * mlon) + 2; H = int((max(lats) - min(lats)) * mlat) + 2
    def img(rings):
        im = Image.new("L", (W, H), 0); dr = ImageDraw.Draw(im)
        for r in rings: dr.polygon([((p["lon"] - min(lons)) * mlon, (max(lats) - p["lat"]) * mlat) for p in r], fill=255)
        return np.array(im) > 0
    A, B = img(a), img(b)
    return round(float((A & B).sum() / max(1, (A | B).sum())), 2)

if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    cache = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(out) or ".", "naip")
    os.makedirs(cache, exist_ok=True)
    C = json.load(open(src)); report = []
    for h in C["holes"]:
        if h["par"] < 4:
            report.append({"hole": h["hole"], "par": h["par"], "fairway": "none (par 3)"}); h["fairways"] = []; continue
        osm = h.get("fairways") or []
        h["osmFairways"] = osm
        found = outline(h, cache)
        polys, m2, notes = found if found else ([], 0, {"pass": "none"})
        row = {"hole": h["hole"], "par": h["par"], "polys": len(polys), "yds2": int(m2 * 1.196), **notes}
        if osm and polys: row["overlap_with_osm"] = iou(osm, polys, h)
        if not polys:
            row["fairway"] = "not found" + (" - kept OSM's" if osm else "")
            if osm: polys = osm
        h["fairways"] = polys; h["fairwaySource"] = "naip" if polys is not osm else "osm"; del h["osmFairways"]
        report.append(row); print(json.dumps(row))
    json.dump(C, open(out, "w"))
    json.dump(report, open(os.path.splitext(out)[0] + "-fairways-report.json", "w"), indent=1)
