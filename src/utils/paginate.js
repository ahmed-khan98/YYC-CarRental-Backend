export function paginationOptions(req, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1), maxLimit);
  return { page, limit };
}

export function wantsPagination(req) {
  return req.query.page != null || req.query.limit != null;
}

export function paginationMeta(result) {
  return {
    page: result.page,
    limit: result.limit,
    total: result.totalDocs,
    totalPages: result.totalPages,
    hasNext: result.hasNextPage,
    hasPrev: result.hasPrevPage,
    nextPage: result.nextPage ?? null,
    prevPage: result.prevPage ?? null,
  };
}

export async function aggregatePaginate(model, pipeline, req, options = {}) {
  const { page, limit } = paginationOptions(req, options);
  return model.aggregatePaginate(model.aggregate(pipeline), { page, limit });
}

export function paginatedPayload(items, result) {
  return {
    items,
    meta: paginationMeta(result),
  };
}
