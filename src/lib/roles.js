/**
 * Role hierarchy:
 *   regional_manager  — top-level super admin, sees everything, manages users
 *   him               — Head Inventory Manager, manages all stores/events/schedules
 *   admin             — legacy alias for him (backward compat for existing accounts)
 *   owner             — read-only reports
 *   gm                — store-level + expense log
 *   store_user        — store-level inventory manager (IM)
 */

// Roles that have HIM-level access (all-store management)
const HIM_ROLES = ['regional_manager', 'him', 'admin'];

// Roles that can manage users
const USER_ADMIN_ROLES = ['regional_manager', 'him', 'admin'];

// Roles that can see owner-level reports
const OWNER_ROLES = ['regional_manager', 'him', 'admin', 'owner'];

// Roles that get store-level access (scoped to their store_id)
const STORE_ROLES = ['regional_manager', 'him', 'admin', 'store_user', 'gm'];

function isHim(role) {
  return HIM_ROLES.includes(role);
}

function isUserAdmin(role) {
  return USER_ADMIN_ROLES.includes(role);
}

function isOwnerLevel(role) {
  return OWNER_ROLES.includes(role);
}

function isStoreLevel(role) {
  return STORE_ROLES.includes(role);
}

/**
 * Express middleware helpers
 */
function requireHim(req, res, next) {
  if (!isHim(req.user?.role)) return res.status(403).json({ error: 'Admin access required' });
  next();
}

function requireUserAdmin(req, res, next) {
  if (!isUserAdmin(req.user?.role)) return res.status(403).json({ error: 'Admin access required' });
  next();
}

function requireOwnerLevel(req, res, next) {
  if (!isOwnerLevel(req.user?.role)) return res.status(403).json({ error: 'Owner access required' });
  next();
}

module.exports = {
  HIM_ROLES, USER_ADMIN_ROLES, OWNER_ROLES, STORE_ROLES,
  isHim, isUserAdmin, isOwnerLevel, isStoreLevel,
  requireHim, requireUserAdmin, requireOwnerLevel
};
