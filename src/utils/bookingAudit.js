export function actorNameFromUser(user) {
  if (!user) return null;
  const name = typeof user.name === "string" ? user.name.trim() : "";
  if (name) return name;
  const email = typeof user.email === "string" ? user.email.trim() : "";
  return email || null;
}

export function actorRoleFromUser(user) {
  if (user?.role === "admin" || user?.role === "sub_admin") return user.role;
  return "customer";
}

function actorId(user) {
  return user?._id ?? user?.id ?? undefined;
}

export function createdByFields(user) {
  return {
    createdByUserId: actorId(user),
    createdByName: actorNameFromUser(user),
    createdByRole: actorRoleFromUser(user),
  };
}

export function staffUpdatedByFields(user) {
  if (!user || (user.role !== "admin" && user.role !== "sub_admin")) {
    return {};
  }
  return {
    updatedByUserId: actorId(user),
    updatedByName: actorNameFromUser(user),
    updatedByRole: user.role,
  };
}

export function performedByFields(user) {
  return {
    performedByUserId: actorId(user),
    performedByName: actorNameFromUser(user),
    performedByRole: actorRoleFromUser(user),
  };
}

export function checkInPerformedByFields(user) {
  return {
    checkInPerformedByUserId: actorId(user),
    checkInPerformedByName: actorNameFromUser(user),
    checkInPerformedByRole: actorRoleFromUser(user),
  };
}

export function checkOutPerformedByFields(user) {
  return {
    checkOutPerformedByUserId: actorId(user),
    checkOutPerformedByName: actorNameFromUser(user),
    checkOutPerformedByRole: actorRoleFromUser(user),
  };
}

export function applyInspectionActorToBooking(booking, type, user) {
  if (type === "check_in") {
    Object.assign(booking, checkInPerformedByFields(user));
    return;
  }
  if (type === "check_out") {
    Object.assign(booking, checkOutPerformedByFields(user));
  }
}

function toIdString(userId) {
  if (!userId) return "";
  if (typeof userId === "string") {
    if (/^[a-f0-9]{24}$/i.test(userId)) return userId;
    const embedded = userId.match(/ObjectId\('([a-f0-9]{24})'\)/i);
    return embedded?.[1] ?? "";
  }
  if (typeof userId === "object") {
    if (typeof userId.toHexString === "function" && !userId._id && !userId.id) {
      return userId.toHexString();
    }
    const nested = userId._id ?? userId.id;
    if (nested && nested !== userId) return toIdString(nested);
  }
  const value = userId.toString?.() ?? String(userId);
  return /^[a-f0-9]{24}$/i.test(value) ? value : "";
}

function preferActorName(liveName, snapshotName, role) {
  const chosen = liveName || snapshotName || null;
  if (role === "admin" && chosen && /^ahmed\s+khan$/i.test(chosen)) {
    return "Admin";
  }
  return chosen;
}

export async function resolveBookingActor(User, userId, role, storedName) {
  const populated = userId && typeof userId === "object" && (userId.name != null || userId.role != null)
    ? userId
    : null;
  const id = toIdString(userId);
  const snapshotName = typeof storedName === "string" && storedName.trim() ? storedName.trim() : null;

  if (!id) {
    if (!role && !snapshotName) return null;
    const resolvedRole = role || "customer";
    return {
      userId: "",
      name: preferActorName(null, snapshotName, resolvedRole),
      role: resolvedRole,
    };
  }

  if (populated) {
    const resolvedRole = role || actorRoleFromUser(populated);
    return {
      userId: id,
      name: preferActorName(actorNameFromUser(populated), snapshotName, resolvedRole),
      role: resolvedRole,
    };
  }

  const user = await User.findById(id).select("name email role");
  const resolvedRole =
    role ||
    (user?.role === "admin" || user?.role === "sub_admin" || user?.role === "customer"
      ? user.role
      : "customer");

  return {
    userId: id,
    name: preferActorName(actorNameFromUser(user), snapshotName, resolvedRole),
    role: resolvedRole,
  };
}
