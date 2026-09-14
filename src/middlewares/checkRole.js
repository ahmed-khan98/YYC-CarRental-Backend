export const checkRole = (...allowedRoles) => {
  return (req, res, next) => {
    const role = req.user?.role?.toUpperCase?.() || req.user?.role;
    const allowed = allowedRoles.map((r) => String(r).toUpperCase());
    if (!allowed.includes(role)) {
      return res.status(403).json({ message: "You are not authorized for this action" });
    }
    next();
  };
};

export const requireStaff = checkRole("admin", "sub_admin");
export const requireFullAdmin = checkRole("admin");
export const requireAdmin = requireStaff;
