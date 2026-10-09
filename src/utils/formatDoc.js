function isObjectIdLike(value) {
  return Boolean(value && typeof value === "object" && value._bsontype === "ObjectId");
}

export function formatDoc(doc) {
  if (doc == null || typeof doc !== "object" || isObjectIdLike(doc)) return null;

  let obj;
  try {
    obj = typeof doc.toObject === "function"
      ? doc.toObject({ flattenObjectIds: true, versionKey: false })
      : { ...doc };
  } catch {
    return null;
  }
  if (obj == null || typeof obj !== "object") return null;

  const rawId = obj._id;
  let id = "";
  try {
    if (rawId != null) {
      id = typeof rawId.toString === "function" ? rawId.toString() : String(rawId);
    }
  } catch {
    id = "";
  }
  const createdAt = obj.createdAt ?? obj._creationTime;
  const updatedAt = obj.updatedAt ?? obj._updatedTime;
  const { __v, password, refreshToken, ...rest } = obj;

  let creationTime = Date.now();
  let updatedTime;
  try {
    if (createdAt) {
      const ms = new Date(createdAt).getTime();
      if (Number.isFinite(ms)) creationTime = ms;
    }
    if (updatedAt) {
      const ms = new Date(updatedAt).getTime();
      if (Number.isFinite(ms)) updatedTime = ms;
    }
  } catch {
    // keep defaults — list endpoints must not 500 on bad dates
  }

  return {
    ...rest,
    _id: id,
    _creationTime: creationTime,
    _updatedTime: updatedTime,
  };
}

export function formatDocs(docs) {
  return docs.map(formatDoc);
}
