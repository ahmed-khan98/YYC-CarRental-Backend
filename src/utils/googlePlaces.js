import { getCached, setCached } from "./ttlCache.js";

const GOOGLE_RATING_CACHE_MS = 6 * 60 * 60 * 1000;

function placeId() {
  return process.env.GOOGLE_PLACE_ID?.trim() || "";
}

function apiKey() {
  return process.env.GOOGLE_PLACES_API_KEY?.trim() || "";
}

export function googleReviewsUrl() {
  const id = placeId();
  if (!id) return null;
  return `https://search.google.com/local/reviews?placeid=${encodeURIComponent(id)}`;
}

export async function getGooglePlaceRating() {
  const id = placeId();
  const key = apiKey();
  if (!id || !key) return { rating: null, reviewCount: null };

  const cacheKey = "google:place-rating";
  const hit = getCached(cacheKey);
  if (hit !== undefined) return hit;

  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "rating,userRatingCount",
      },
    });
    if (!res.ok) return { rating: null, reviewCount: null };
    const data = await res.json();
    const value = {
      rating: typeof data.rating === "number" ? data.rating : null,
      reviewCount: typeof data.userRatingCount === "number" ? data.userRatingCount : null,
    };
    setCached(cacheKey, value, GOOGLE_RATING_CACHE_MS);
    return value;
  } catch {
    return { rating: null, reviewCount: null };
  }
}
