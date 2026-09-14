/** Normalize optional string fields on PATCH so cleared values persist. */
export function patchText(value) {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value.trim() : value;
}

/** Normalize optional numeric fields on PATCH — empty string/null clears the value. */
export function patchOptionalNumber(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Apply text/number normalizers to known optional keys on an update body. */
export function normalizeUpdateBody(body, { textKeys = [], numberKeys = [] } = {}) {
  const patch = { ...body };
  for (const key of textKeys) {
    if (key in patch) patch[key] = patchText(patch[key]);
  }
  for (const key of numberKeys) {
    if (key in patch) patch[key] = patchOptionalNumber(patch[key]);
  }
  return patch;
}
