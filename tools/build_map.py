"""Собирает карту для CRM: выгрузка Protomaps (OpenStreetMap) по Эстонии и Таллинну.

Эстония z0-9, Таллинн z10-14, центр z15 -> site/map/tallinn.pmtiles
Запуск: python3 build_map.py 20261122
"""
import math, sys, os, threading, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pmtiles.reader import Reader, zxy_to_tileid
from pmtiles.writer import write

BUILD = sys.argv[1]
URL = f"https://build.protomaps.com/{BUILD}.pmtiles"
OUT = os.path.join(os.path.dirname(__file__), "..", "map")
REGIONS = [  # (minlon, minlat, maxlon, maxlat, minz, maxz)
    (21.6, 57.45, 28.4, 59.8, 0, 9),     # Эстония
    (24.50, 59.33, 25.00, 59.52, 10, 14), # Таллинн
    (24.69, 59.415, 24.81, 59.45, 15, 15),  # центр
]
SIZE = 12_000_000

cache, lock = {}, threading.Lock()
def get_bytes(off, length):
    key = (off, length)
    with lock:
        if key in cache:
            return cache[key]
    req = urllib.request.Request(URL, headers={"Range": f"bytes={off}-{off+length-1}", "User-Agent": "icecraft-crm-map-builder/1.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            break
        except Exception:
            if attempt == 3:
                raise
    if length < 2_000_000:  # каталоги кешируем, тайлы нет
        with lock:
            cache[key] = data
    return data

def lon2x(lon, z): return int((lon + 180) / 360 * 2**z)
def lat2y(lat, z):
    r = math.radians(lat)
    return int((1 - math.asinh(math.tan(r)) / math.pi) / 2 * 2**z)

tiles = set()
for minlon, minlat, maxlon, maxlat, z0, z1 in REGIONS:
    for z in range(z0, z1 + 1):
        for x in range(lon2x(minlon, z), lon2x(maxlon, z) + 1):
            for y in range(lat2y(maxlat, z), lat2y(minlat, z) + 1):
                tiles.add((z, x, y))
print("тайлов:", len(tiles))

reader = Reader(get_bytes)
header = reader.header()
metadata = reader.metadata()

def fetch(t):
    return t, reader.get(*t)
results = {}
with ThreadPoolExecutor(16) as ex:
    for i, (t, data) in enumerate(ex.map(fetch, sorted(tiles))):
        if data:
            results[zxy_to_tileid(*t)] = data
        if i % 500 == 0:
            print(i, "/", len(tiles), flush=True)

os.makedirs(OUT, exist_ok=True)
tmp = os.path.join(OUT, "tallinn.pmtiles")
with write(tmp) as w:
    for tid in sorted(results):
        w.write_tile(tid, results[tid])
    hdr = {k: header[k] for k in ("tile_type", "tile_compression", "center_zoom")}
    hdr.update(min_zoom=0, max_zoom=15, min_lon_e7=int(21.6e7), min_lat_e7=int(57.45e7),
               max_lon_e7=int(28.4e7), max_lat_e7=int(59.8e7),
               center_lon_e7=int(24.745e7), center_lat_e7=int(59.437e7), center_zoom=12)
    metadata["description"] = f"IceCraft CRM: Эстония z0-9, Таллинн z10-14, центр z15 (Protomaps {BUILD})"
    w.finalize(hdr, metadata)

print("готово:", os.path.getsize(tmp), "байт ->", tmp)
