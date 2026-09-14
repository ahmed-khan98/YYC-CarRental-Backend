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
  return userId.toString?.() ?? String(userId);
}

export async function resolveBookingActor(User, userId, role, storedName) {
  const id = toIdString(userId);
  const snapshotName = typeof storedName === "string" && storedName.trim() ? storedName.trim() : null;

  if (id && snapshotName && role) {
    return { userId: id, name: snapshotName, role };
  }

  if (!id) {
    if (!role && !snapshotName) return null;
    return {
      userId: "",
      name: snapshotName,
      role: role || "customer",
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
    name: snapshotName ?? actorNameFromUser(user),
    role: resolvedRole,
  };
}
