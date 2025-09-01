import NodeCache from "node-cache";
const cache = new NodeCache({ stdTTL: 300 });

export async function getCloudFraction(lat, lon, date = new Date()) {
  const key = `${lat.toFixed(3)}:${lon.toFixed(3)}:${date
    .toISOString()
    .slice(0, 13)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=cloud_cover&forecast_hours=1&timeformat=iso8601`;
  const res = await fetch(url);
  if (!res.ok) return undefined;
  const data = await res.json();
  const cover = data?.hourly?.cloud_cover?.[0];
  if (typeof cover !== "number") return undefined;
  const frac = Math.max(0, Math.min(1, cover / 100));
  cache.set(key, frac);
  return frac;
}
