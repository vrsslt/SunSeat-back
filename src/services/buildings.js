import axios from "axios";

const buildingCache = new Map(); // key -> { data, t }
const TTL = 10 * 60 * 1000; // 10 min

function heightFromTags(tags) {
  const h = Number(tags?.height);
  if (Number.isFinite(h)) return h;
  const lv = Number(tags?.["building:levels"]);
  if (Number.isFinite(lv)) return lv * 3; // ~3m/étage
  return 12; // défaut urbain
}

export async function getBuildings(lat, lon, radiusMeters = 150) {
  const k = `${lat.toFixed(4)}_${lon.toFixed(4)}_${radiusMeters}`;
  const c = buildingCache.get(k);
  const now = Date.now();
  if (c && now - c.t < TTL) return c.data;

  const q = `
    [out:json][timeout:25];
    (
      way["building"](around:${radiusMeters},${lat},${lon});
      relation["building"](around:${radiusMeters},${lat},${lon});
    );
    out center tags;
  `;

  const r = await axios.post("https://overpass-api.de/api/interpreter", q, {
    headers: {
      "Content-Type": "text/plain",
      "User-Agent": "SunSeat/0.1 (contact: you@example.com)",
    },
    timeout: 15000,
  });

  const els = r.data?.elements ?? [];
  const buildings = els
    .map((e) => ({
      id: e.id,
      height_m: heightFromTags(e.tags),
      centroid: { lat: e.center?.lat ?? e.lat, lon: e.center?.lon ?? e.lon },
    }))
    .filter(
      (b) => Number.isFinite(b.centroid.lat) && Number.isFinite(b.centroid.lon)
    );

  buildingCache.set(k, { data: buildings, t: now });
  return buildings;
}
