// index.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import compression from "compression";
import axios from "axios";

import { sunScore } from "./src/services/sun.js";
import { getCloudFraction } from "./src/services/meteo.js";
import { getBuildings } from "./src/services/buildings.js";
import { getSunAngles, isShadedByBuildings } from "./src/services/shade.js";

const app = express();

/* ---------- CORS (dev + prod) ---------- */
const allowedOrigins = new Set([
  "http://localhost:5173", // Vite dev
  "http://localhost:4173", // Vite preview
  "https://sun-seat-front.vercel.app", // ton front prod
]);
if (process.env.FRONT_URL) allowedOrigins.add(process.env.FRONT_URL);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl/healthchecks
    return allowedOrigins.has(origin)
      ? cb(null, true)
      : cb(new Error(`Not allowed by CORS: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
};

// Applique cors uniquement au namespace /api (suffisant et propre)
app.use("/api", cors(corsOptions));

/* ---------- Middlewares ---------- */
app.use(express.json());
app.use(morgan("dev"));
app.use(compression());

/* ---------- Cache simple ---------- */
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 min

/* ---------- Health ---------- */
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* ---------- Util distance ---------- */
function toRad(v) {
  return (v * Math.PI) / 180;
}
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ---------- Overpass: bars/restos/cafés ---------- */
async function getNearbyBarsAndRestaurants(lat, lon, radiusMeters = 1500) {
  const cacheKey = `${lat.toFixed(4)}_${lon.toFixed(4)}_${radiusMeters}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log("📦 Using cached data for", cacheKey);
    return cached.data;
  }

  const overpassQuery = `
    [out:json][timeout:25];
    (
      node["amenity"~"^(bar|restaurant|cafe|pub|biergarten)$"](around:${radiusMeters},${lat},${lon});
      way["amenity"~"^(bar|restaurant|cafe|pub|biergarten)$"](around:${radiusMeters},${lat},${lon});
      relation["amenity"~"^(bar|restaurant|cafe|pub|biergarten)$"](around:${radiusMeters},${lat},${lon});
    );
    out center meta;
  `;

  try {
    console.log(
      "🔍 Overpass amenities within",
      radiusMeters,
      "m around",
      lat,
      lon
    );

    const response = await axios.post(
      "https://overpass-api.de/api/interpreter",
      overpassQuery,
      {
        headers: {
          "Content-Type": "text/plain",
          "User-Agent": "SunSeat/0.1 (contact: you@example.com)",
        },
        timeout: 15000,
      }
    );

    const elements = response.data?.elements ?? [];
    if (!elements.length) {
      console.warn("⚠️ No elements in Overpass response");
      cache.set(cacheKey, { data: [], timestamp: Date.now() });
      return [];
    }

    const places = elements
      .filter((e) => {
        const plat = e.lat || e.center?.lat;
        const plon = e.lon || e.center?.lon;
        return Number.isFinite(plat) && Number.isFinite(plon);
      })
      .map((e) => {
        const placeLat = e.lat || e.center?.lat;
        const placeLon = e.lon || e.center?.lon;
        const distance = calculateDistance(lat, lon, placeLat, placeLon);
        const orientationDeg = (e.id * 37) % 360;

        let streetWidth = "medium";
        if (e.tags?.amenity === "biergarten") streetWidth = "wide";
        if (e.tags?.amenity === "cafe") streetWidth = "narrow";

        return {
          id: e.id,
          name: e.tags?.name || e.tags?.brand || "Bar sans nom",
          lat: placeLat,
          lon: placeLon,
          amenity: e.tags?.amenity,
          outdoor_seating: e.tags?.outdoor_seating,
          orientationDeg,
          streetWidth,
          distance_m: Math.round(distance),
          cuisine: e.tags?.cuisine,
          opening_hours: e.tags?.opening_hours,
          website: e.tags?.website,
          phone: e.tags?.phone,
        };
      })
      .sort((a, b) => a.distance_m - b.distance_m);

    console.log(`✅ Found ${places.length} places`);
    cache.set(cacheKey, { data: places, timestamp: Date.now() });
    return places;
  } catch (err) {
    console.error("❌ Overpass amenities error:", err.message);
    console.log("🔄 Falling back to demo data");
    return [
      {
        id: Date.now() + 1,
        name: "Le Rayon Vert",
        lat: lat + 0.001,
        lon: lon + 0.001,
        amenity: "bar",
        orientationDeg: 180,
        streetWidth: "medium",
        distance_m: 120,
      },
      {
        id: Date.now() + 2,
        name: "Chez Azur",
        lat: lat - 0.001,
        lon: lon + 0.0005,
        amenity: "restaurant",
        orientationDeg: 220,
        streetWidth: "narrow",
        distance_m: 340,
      },
    ];
  }
}

/* ---------- Route principale ---------- */
// GET /api/terraces/nearby?lat=...&lon=...&radius=1500&forecast=true
app.get("/api/terraces/nearby", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  // garde-fous sur radius
  const radius = Math.min(
    Math.max(Number(req.query.radius || 1500), 100),
    3000
  );
  const forecast = String(req.query.forecast || "false") === "true";
  const useDemo = String(req.query.demo || "false") === "true";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res
      .status(400)
      .json({ error: "bad_params", message: "lat and lon are required" });
  }

  console.log(`🔍 Nearby @ ${lat}, ${lon} r=${radius}m forecast=${forecast}`);

  try {
    // météo (fraction nuageuse) — ta fonction le gère déjà
    const cloudFraction = await getCloudFraction(lat, lon).catch(() => {
      console.warn("⚠️ Could not get cloud fraction, using default 0.3");
      return 0.3;
    });

    // lieux
    const places = useDemo
      ? []
      : await getNearbyBarsAndRestaurants(lat, lon, radius);
    if (places.length === 0 && !useDemo) {
      console.log("⚠️ No places found (try ?demo=true for test data)");
    }

    // bâtiments autour du centre (suffit : 150–200m)
    const buildings = await getBuildings(lat, lon, Math.min(radius, 200)).catch(
      () => []
    );

    const now = new Date();

    const items = places.map((p) => {
      const base = {
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        orientationDeg: p.orientationDeg,
        streetWidth: p.streetWidth,
        distance_m: p.distance_m,
        amenity: p.amenity,
        cuisine: p.cuisine,
        opening_hours: p.opening_hours,
        outdoor_seating: p.outdoor_seating,
      };

      // score brut (inclut déjà cloudFraction)
      const scoreRaw = sunScore({
        lat: p.lat,
        lon: p.lon,
        orientationDeg: p.orientationDeg,
        streetWidth: p.streetWidth,
        date: now,
        cloudFraction,
      });

      // ombre (maintenant)
      const sunNow = getSunAngles(now, p.lat, p.lon);
      const shade = isShadedByBuildings(
        { lat: p.lat, lon: p.lon },
        sunNow,
        buildings,
        { maxDist: 80, azTolerance: 25 }
      );
      const shadeFactor = shade.shaded
        ? 0.4 - 0.2 * (shade.confidence || 0)
        : 1;
      const score = Math.max(
        0,
        Math.min(100, Math.round(scoreRaw * shadeFactor))
      );

      const out = { ...base, sunScore: score };

      // forecast (recalcule angles solaires, réutilise la même géométrie de bâtiments)
      if (forecast) {
        out.forecast = [0, 15, 30, 45, 60, 90, 120].map((min) => {
          const d = new Date(now.getTime() + min * 60000);
          const raw = sunScore({
            lat: p.lat,
            lon: p.lon,
            orientationDeg: p.orientationDeg,
            streetWidth: p.streetWidth,
            date: d,
            cloudFraction,
          });
          const sunT = getSunAngles(d, p.lat, p.lon);
          const shadeT = isShadedByBuildings(
            { lat: p.lat, lon: p.lon },
            sunT,
            buildings,
            { maxDist: 80, azTolerance: 25 }
          );
          const factorT = shadeT.shaded
            ? 0.4 - 0.2 * (shadeT.confidence || 0)
            : 1;
          const final = Math.max(0, Math.min(100, Math.round(raw * factorT)));
          return { tmin: min, score: final };
        });
      }

      return out;
    });

    const sorted = items.sort((a, b) => b.sunScore - a.sunScore);
    console.log(`✅ Returning ${sorted.length} places with shade-aware scores`);
    res.json(sorted);
  } catch (error) {
    console.error("❌ Error in /api/terraces/nearby:", error);
    res.status(500).json({
      error: "internal_error",
      message: error.message,
      fallback: "Try adding ?demo=true to get test data",
    });
  }
});

/* ---------- Endpoint legacy (non implémenté) ---------- */
app.get("/api/terraces/:id/sunscore", (_req, res) => {
  res.status(501).json({
    error: "not_implemented",
    message: "This endpoint needs an Overpass fetch for a specific place",
  });
});

/* ---------- Nettoyage cache ---------- */
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_DURATION * 12) {
      cache.delete(key); // > 1h
    }
  }
  console.log(`🧹 Cache cleanup: ${cache.size} entries remaining`);
}, 60 * 60 * 1000);

/* ---------- Boot ---------- */
const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`✅ API running on http://localhost:${port}`);
  console.log(
    `📍 Try: http://localhost:${port}/api/terraces/nearby?lat=48.8566&lon=2.3522&radius=1000&forecast=true`
  );
});
