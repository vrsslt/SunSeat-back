import SunCalc from "suncalc";

// utils angulaires/géo rapides (ok à l’échelle urbaine)
const PI = Math.PI;
const RAD = 180 / PI;

export function toDeg(rad) {
  return rad * RAD;
}
export function toRad(deg) {
  return deg / RAD;
}

export function angleDiffDeg(a, b) {
  // écart absolu (0..180)
  let d = Math.abs(((a - b + 540) % 360) - 180);
  return d;
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1),
    φ2 = toRad(lat2);
  const λ1 = toRad(lon1),
    λ2 = toRad(lon2);
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  return (toDeg(Math.atan2(y, x)) + 360) % 360; // 0=N, 90=E
}

export function distanceMeters(lat1, lon1, lat2, lon2) {
  // equirectangular rapide (précis <~2km)
  const latm = (lat1 + lat2) / 2;
  const mPerDegLat = 111_132;
  const mPerDegLon = 111_320 * Math.cos(toRad(latm));
  const dy = (lat2 - lat1) * mPerDegLat;
  const dx = (lon2 - lon1) * mPerDegLon;
  return Math.hypot(dx, dy);
}

// SunCalc: azimuth rad = 0 vers le sud, négatif = est ; altitude rad
// On convertit en cap/bearing: 0=N, 90=E
export function getSunAngles(date, lat, lon) {
  const pos = SunCalc.getPosition(date, lat, lon);
  const azimuthDeg = (toDeg(pos.azimuth) + 180 + 360) % 360; // sud->180°, est->90°
  const altitudeDeg = toDeg(pos.altitude);
  return { azimuthDeg, altitudeDeg };
}

/**
 * Détermine si un bâtiment place la terrasse à l'ombre.
 * Heuristique :
 *  - le bâtiment est "dans l'axe vers le soleil" (± azTolerance)
 *  - angle apparent du haut du bâtiment (atan(h/d)) > altitude solaire
 */
export function isShadedByBuildings(
  terrace, // { lat, lon }
  sun, // { azimuthDeg, altitudeDeg }
  buildings, // [{ id, height_m, centroid:{lat,lon} }]
  opts = { maxDist: 80, azTolerance: 25 } // 80 m, ±25°
) {
  const { maxDist, azTolerance } = opts;
  const azUpSun = (sun.azimuthDeg + 180) % 360; // direction "vers" le soleil depuis la terrasse
  const alt = sun.altitudeDeg;

  let best = { shaded: false, confidence: 0, culprit: undefined };

  for (const b of buildings) {
    const d = distanceMeters(
      terrace.lat,
      terrace.lon,
      b.centroid.lat,
      b.centroid.lon
    );
    if (d > maxDist) continue;

    const azToB = bearingDeg(
      terrace.lat,
      terrace.lon,
      b.centroid.lat,
      b.centroid.lon
    );
    const delta = angleDiffDeg(azToB, azUpSun);
    if (delta > azTolerance) continue;

    const elev = toDeg(Math.atan2(b.height_m || 0, d)); // angle apparent
    if (elev >= alt) {
      // confiance ↑ si delta petit et marge (elev-alt) grande
      const conf = Math.min(1, ((elev - alt) / 10) * (1 - delta / azTolerance));
      if (conf > best.confidence)
        best = { shaded: true, confidence: conf, culprit: b };
    }
  }
  return best;
}
