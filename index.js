import express from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";
import { sunScore } from "./src/services/sun.js";
import { getCloudFraction } from "./src/services/meteo.js";

const app = express();

// ===== CORS: dev + prod =====
const allowedOrigins = new Set([
  "http://localhost:5173",
  "http://localhost:4173",
  "https://sun-seat-front.vercel.app",
]);
if (process.env.FRONT_URL) allowedOrigins.add(process.env.FRONT_URL);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // ex: curl, SSR
    return allowedOrigins.has(origin)
      ? cb(null, true)
      : cb(new Error(`Not allowed by CORS: ${origin}`));
  },
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
};

// Active CORS globalement
app.use(cors(corsOptions));

// ✅ Remplace la ligne problématique par une RegExp (préflight)
app.options(/^\/api\/.*$/, cors(corsOptions)); // matche toutes les routes /api/...

app.use(express.json());
app.use(morgan("dev"));

// ====== Cache simple Overpass ======
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 min

app.get("/api/health", (req, res) => res.json({ ok: true }));

// ===== Utils =====
function toRad(value) {
  return (value * Math.PI) / 180;
}
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// ===== Overpass =====
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
    console.log("🔍 Overpass radius", radiusMeters, "around", lat, lon);
    const response = await axios.post(
      "https://overpass-api.de/api/interpreter",
      overpassQuery,
      { headers: { "Content-Type": "text/plain" }, timeout: 15000 }
    );

    if (!response.data || !response.data.elements) {
      console.warn("⚠️ No elements in Overpass response");
      return [];
    }

    const places = response.data.elements
      .filter((el) => (el.lat || el.center?.lat) && (el.lon || el.center?.lon))
      .map((el) => {
        const placeLat = el.lat || el.center?.lat;
        const placeLon = el.lon || el.center?.lon;
        const distance = calculateDistance(lat, lon, placeLat, placeLon);
        const tags = el.tags || {};

        // Estimations visuelles simples
        const orientationDeg = (el.id * 37) % 360;
        let streetWidth = "medium";
        if (tags.amenity === "biergarten") streetWidth = "wide";
        if (tags.amenity === "cafe") streetWidth = "narrow";

        // ====== Détection terrasse OSM (tags forts) ======
        // on accumule de la "confiance"
        let conf = 0;
        const evidence = [];

        if (tags.outdoor_seating === "yes") {
          conf += 0.8;
          evidence.push("osm:outdoor_seating=yes");
        }
        if (typeof tags["seats:outside"] !== "undefined") {
          conf += 0.25;
          evidence.push(`osm:seats:outside=${tags["seats:outside"]}`);
        }
        if (tags.terrace === "yes") {
          conf = Math.max(conf, 0.7);
          evidence.push("osm:terrace=yes");
        }
        if (tags.amenity === "biergarten") {
          conf = Math.max(conf, 0.95);
          evidence.push("osm:biergarten");
        }
        if (tags["outdoor_seating:covered"] === "yes") {
          evidence.push("osm:outdoor_seating:covered=yes");
          conf = Math.min(1, conf + 0.05);
        }

        conf = clamp(conf, 0, 1);
        const hasOutdoor = conf >= 0.6;

        return {
          id: el.id,
          name: tags.name || tags.brand || "Bar sans nom",
          lat: placeLat,
          lon: placeLon,
          amenity: tags.amenity,
          outdoor_seating: tags.outdoor_seating,
          orientationDeg,
          streetWidth,
          distance_m: Math.round(distance),

          // infos utiles
          cuisine: tags.cuisine,
          opening_hours: tags.opening_hours,
          website: tags.website,
          phone: tags.phone,

          // NEW terrasse
          hasOutdoor,
          terraceConfidence: Number(conf.toFixed(2)), // 0..1
          terraceEvidence: evidence, // ["osm:outdoor_seating", ...]
        };
      })
      .sort((a, b) => a.distance_m - b.distance_m);

    console.log(`✅ Found ${places.length} places from Overpass API`);

    cache.set(cacheKey, { data: places, timestamp: Date.now() });
    return places;
  } catch (error) {
    console.error("❌ Overpass API error:", error.message);
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
        hasOutdoor: true,
        terraceConfidence: 0.9,
        terraceEvidence: ["demo"],
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
        hasOutdoor: false,
        terraceConfidence: 0.2,
        terraceEvidence: ["demo"],
      },
    ];
  }
}

// ===== API =====
// GET /api/terraces/nearby?lat=...&lon=...&radius=1500&forecast=true
app.get("/api/terraces/nearby", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Number(req.query.radius || 1500);
  const forecast = String(req.query.forecast || "false") === "true";
  const useDemo = String(req.query.demo || "false") === "true";

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return res
      .status(400)
      .json({ error: "bad_params", message: "lat and lon are required" });
  }

  console.log(`🔍 Looking for places around ${lat}, ${lon} within ${radius}m`);

  try {
    const cloudFraction = await getCloudFraction(lat, lon).catch(() => {
      console.warn("⚠️ Could not get cloud fraction, using default");
      return 0.3;
    });

    const places = useDemo
      ? []
      : await getNearbyBarsAndRestaurants(lat, lon, radius);
    if (places.length === 0 && !useDemo) {
      console.log("⚠️ No places found, try ?demo=true for test data");
    }

    const now = new Date();

    const items = places.map((place) => {
      const base = {
        id: place.id,
        name: place.name,
        lat: place.lat,
        lon: place.lon,
        orientationDeg: place.orientationDeg,
        streetWidth: place.streetWidth,
        distance_m: place.distance_m,
        amenity: place.amenity,

        // pass-through infos
        cuisine: place.cuisine,
        opening_hours: place.opening_hours,
        outdoor_seating: place.outdoor_seating,
        website: place.website,
        phone: place.phone,

        // NEW terrasse
        hasOutdoor: !!place.hasOutdoor,
        terraceConfidence: Number(place.terraceConfidence ?? 0),
        terraceEvidence: Array.isArray(place.terraceEvidence)
          ? place.terraceEvidence
          : [],
      };

      const score = sunScore({
        lat: place.lat,
        lon: place.lon,
        orientationDeg: place.orientationDeg,
        streetWidth: place.streetWidth,
        date: now,
        cloudFraction,
      });

      const out = { ...base, sunScore: score };

      if (forecast) {
        out.forecast = [0, 15, 30, 45, 60, 90, 120].map((min) => {
          const d = new Date(now.getTime() + min * 60000);
          return {
            tmin: min,
            score: sunScore({
              lat: place.lat,
              lon: place.lon,
              orientationDeg: place.orientationDeg,
              streetWidth: place.streetWidth,
              date: d,
              cloudFraction,
            }),
          };
        });
      }

      return out;
    });

    const sorted = items.sort((a, b) => b.sunScore - a.sunScore);
    console.log(`✅ Returning ${sorted.length} places with sun scores`);
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

// legacy (non implémenté)
app.get("/api/terraces/:id/sunscore", async (req, res) => {
  res.status(501).json({
    error: "not_implemented",
    message:
      "This endpoint needs to be updated to work with dynamic data from Overpass API",
  });
});

// cleanup cache
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_DURATION * 12) cache.delete(key);
  }
  console.log(`🧹 Cache cleanup: ${cache.size} entries remaining`);
}, 60 * 60 * 1000);

const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`✅ API running on http://localhost:${port}`);
  console.log(
    `📍 Try: http://localhost:${port}/api/terraces/nearby?lat=48.8566&lon=2.3522&radius=1000`
  );
});
