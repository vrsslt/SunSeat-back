import express from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";
import { sunScore } from "./src/services/sun.js";
import { getCloudFraction } from "./src/services/meteo.js";

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());
app.use(morgan("dev"));

// Cache simple pour éviter de spammer Overpass API
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Fonction pour récupérer les bars/restaurants via Overpass API
async function getNearbyBarsAndRestaurants(lat, lon, radiusMeters = 1500) {
  const cacheKey = `${lat.toFixed(4)}_${lon.toFixed(4)}_${radiusMeters}`;
  const cached = cache.get(cacheKey);

  // Vérifier le cache
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
      "🔍 Querying Overpass API for radius",
      radiusMeters,
      "around",
      lat,
      lon
    );

    const response = await axios.post(
      "https://overpass-api.de/api/interpreter",
      overpassQuery,
      {
        headers: { "Content-Type": "text/plain" },
        timeout: 15000,
      }
    );

    if (!response.data || !response.data.elements) {
      console.warn("⚠️ No elements in Overpass response");
      return [];
    }

    const places = response.data.elements
      .filter((element) => {
        const lat = element.lat || element.center?.lat;
        const lon = element.lon || element.center?.lon;
        return lat && lon; // Filtrer les éléments sans coordonnées
      })
      .map((element) => {
        // Calcul de distance approximative
        const placeLat = element.lat || element.center?.lat;
        const placeLon = element.lon || element.center?.lon;
        const distance = calculateDistance(lat, lon, placeLat, placeLon);

        // Estimation d'orientation basée sur l'ID (déterministe mais arbitraire)
        const orientationDeg = (element.id * 37) % 360;

        // Estimation de largeur de rue basée sur le type
        let streetWidth = "medium";
        if (element.tags?.amenity === "biergarten") streetWidth = "wide";
        if (element.tags?.amenity === "cafe") streetWidth = "narrow";

        return {
          id: element.id,
          name: element.tags?.name || element.tags?.brand || "Bar sans nom",
          lat: placeLat,
          lon: placeLon,
          amenity: element.tags?.amenity,
          outdoor_seating: element.tags?.outdoor_seating,
          orientationDeg,
          streetWidth,
          distance_m: Math.round(distance),
          // Ajouter quelques infos utiles
          cuisine: element.tags?.cuisine,
          opening_hours: element.tags?.opening_hours,
          website: element.tags?.website,
          phone: element.tags?.phone,
        };
      })
      .sort((a, b) => a.distance_m - b.distance_m); // Trier par distance

    console.log(`✅ Found ${places.length} places from Overpass API`);

    // Mettre en cache
    cache.set(cacheKey, {
      data: places,
      timestamp: Date.now(),
    });

    return places;
  } catch (error) {
    console.error("❌ Overpass API error:", error.message);

    // En cas d'erreur, retourner quelques données de démonstration
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

// Fonction utilitaire pour calculer la distance (Haversine)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Rayon de la Terre en mètres
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(value) {
  return (value * Math.PI) / 180;
}

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
    // Récupérer les données météo
    const cloudFraction = await getCloudFraction(lat, lon).catch(() => {
      console.warn("⚠️ Could not get cloud fraction, using default");
      return 0.3; // valeur par défaut
    });

    // Récupérer les lieux depuis Overpass API (ou données de démo si demandé)
    const places = useDemo
      ? [] // Force l'utilisation des vraies données
      : await getNearbyBarsAndRestaurants(lat, lon, radius);

    if (places.length === 0 && !useDemo) {
      console.log(
        "⚠️ No places found, you can try with ?demo=true for test data"
      );
    }

    const now = new Date();

    // Calculer le score solaire pour chaque lieu
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
        // Infos supplémentaires
        cuisine: place.cuisine,
        opening_hours: place.opening_hours,
        outdoor_seating: place.outdoor_seating,
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

      // Ajouter les prévisions si demandées
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

    // Trier par score solaire décroissant
    const sortedItems = items.sort((a, b) => b.sunScore - a.sunScore);

    console.log(`✅ Returning ${sortedItems.length} places with sun scores`);

    res.json(sortedItems);
  } catch (error) {
    console.error("❌ Error in /api/terraces/nearby:", error);
    res.status(500).json({
      error: "internal_error",
      message: error.message,
      // En cas d'erreur serveur, on peut quand même renvoyer des données de test
      fallback: "Try adding ?demo=true to get test data",
    });
  }
});

// GET /api/terraces/:id/sunscore - garder l'endpoint existant pour la compatibilité
app.get("/api/terraces/:id/sunscore", async (req, res) => {
  const id = Number(req.params.id);

  // Pour l'instant, cet endpoint ne fonctionne qu'avec les données de démo
  // Tu pourrais l'améliorer pour faire une nouvelle requête Overpass pour un lieu spécifique

  res.status(501).json({
    error: "not_implemented",
    message:
      "This endpoint needs to be updated to work with dynamic data from Overpass API",
  });
});

// Nettoyage du cache toutes les heures
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_DURATION * 12) {
      // Nettoie les entrées de plus d'1h
      cache.delete(key);
    }
  }
  console.log(`🧹 Cache cleanup: ${cache.size} entries remaining`);
}, 60 * 60 * 1000);

const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(
    `✅ API with Overpass integration running on http://localhost:${port}`
  );
  console.log(
    `📍 Try: http://localhost:${port}/api/terraces/nearby?lat=48.8566&lon=2.3522&radius=1000`
  );
});
