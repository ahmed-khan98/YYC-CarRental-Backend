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
  const id = rawId == null ? "" : (rawId.toString?.() ?? String(rawId));
  const createdAt = obj.createdAt ?? obj._creationTime;
  const updatedAt = obj.updatedAt ?? obj._updatedTime;
  const { __v, password, refreshToken, ...rest } = obj;

  return {
    ...rest,
    _id: id,
    _creationTime: createdAt ? new Date(createdAt).getTime() : Date.now(),
    _updatedTime: updatedAt ? new Date(updatedAt).getTime() : undefined,
  };
}

export function formatDocs(docs) {
  return docs.map(formatDoc);
}
