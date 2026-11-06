import { AdditionalService } from "../models/additionalService.model.js";

/** One query for many service ids. Callers still iterate the original id order. */
export async function loadServicesByIds(ids = [], Model = AdditionalService) {
  const ordered = (ids ?? []).map((id) => String(id ?? "")).filter(Boolean);
  const unique = [...new Set(ordered)];
  if (!unique.length) return { byId: new Map(), ordered: [] };

  const services = await Model.find({ _id: { $in: unique } });
  const byId = new Map(services.map((svc) => [String(svc._id), svc]));
  return {
    byId,
    ordered: ordered.map((id) => byId.get(id)).filter(Boolean),
  };
}
