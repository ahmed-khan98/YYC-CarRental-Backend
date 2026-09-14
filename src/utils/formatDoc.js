export function formatDoc(doc) {
  if (!doc) return null;
  const obj = doc.toObject
    ? doc.toObject({ flattenObjectIds: true, versionKey: false })
    : { ...doc };

  const id = obj._id?.toString?.() ?? String(obj._id ?? "");
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
