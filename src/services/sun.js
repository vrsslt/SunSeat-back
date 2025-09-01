import SunCalc from "suncalc";

export function sunScore({
  lat,
  lon,
  orientationDeg,
  streetWidth,
  date = new Date(),
  cloudFraction,
}) {
  const pos = SunCalc.getPosition(date, lat, lon);
  const az = ((pos.azimuth * 180) / Math.PI + 180) % 360;
  const alt = (pos.altitude * 180) / Math.PI;
  const diff = Math.min(
    Math.abs(az - orientationDeg),
    360 - Math.abs(az - orientationDeg)
  );

  let score = 0;
  if (diff < 45) score += 55;
  else if (diff < 90) score += 35;
  else score += 10;
  if (alt < 8) score -= 30;
  else if (alt < 15) score -= 15;
  else score += 10;
  if (alt < 20) {
    if (streetWidth === "narrow") score -= 15;
    else if (streetWidth === "medium") score -= 5;
  }
  if (typeof cloudFraction === "number") score *= 1 - 0.6 * cloudFraction;

  return Math.max(0, Math.min(100, Math.round(score)));
}
