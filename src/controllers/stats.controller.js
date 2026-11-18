import { Car, activeCarsMatch } from "../models/car.model.js";
import { User } from "../models/user.model.js";
import { Location } from "../models/location.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendOk } from "../utils/http.js";
import { getGooglePlaceRating, googleReviewsUrl } from "../utils/googlePlaces.js";

export const getPublicStats = asyncHandler(async (_req, res) => {
  const [cars, customers, locations, google] = await Promise.all([
    Car.countDocuments(activeCarsMatch()),
    User.countDocuments({ role: "customer" }),
    Location.countDocuments({ isActive: { $ne: false } }),
    getGooglePlaceRating(),
  ]);

  return sendOk(
    res,
    {
      cars,
      customers,
      locations,
      rating: google.rating,
      reviewCount: google.reviewCount,
      reviewsUrl: googleReviewsUrl(),
    },
    "Stats fetched",
  );
});
