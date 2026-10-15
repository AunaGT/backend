const { hasPerm, requireCompany } = require("../../../middlewares/tenant"),
  { resolveEffectiveModules } = require("../../platform/registry"),
  { fail } = require("./money");
const has = (scope, p) => scope.isAdmin || scope.permissions.includes(p);
function payableScope(req) {
  if (!req.user?.sub) fail("Inicia sesión", 401, "UNAUTHENTICATED");
  return {
    companyId: requireCompany(req),
    userId: req.user.sub,
    branchId: req.branchId || null,
    branchIds: req.branchIds || [req.branchId].filter(Boolean),
    isAdmin: hasPerm({ ...req.user, permissions: [] }, "merchandise.details"),
    permissions: req.user.permissions || [],
  };
}
function entryWhere(scope) {
  return {
    branch: { company_id: scope.companyId },
    branch_id: scope.branchId || { in: scope.branchIds },
  };
}
async function assertAccess(
  db,
  scope,
  { write = false, exporting = false } = {},
) {
  if (
    !has(scope, write ? "merchandise.mark_paid" : "merchandise.details") ||
    (exporting && !has(scope, "merchandise.reports"))
  )
    fail("No tienes permiso para esta operación", 403, "FORBIDDEN");
  const modules = resolveEffectiveModules(
    await db.companyModule.findMany({ where: { company_id: scope.companyId } }),
  );
  if (!modules.some((m) => m.code === "merchandise" && m.effectiveEnabled))
    fail("Mercancía no está disponible", 403, "MODULE_DISABLED");
  if (write && !scope.branchId)
    fail(
      "Selecciona una sucursal para registrar el pago",
      400,
      "BRANCH_REQUIRED",
    );
  if (
    scope.branchId &&
    (!scope.branchIds.includes(scope.branchId) ||
      !(await db.branch.findFirst({
        where: {
          id: scope.branchId,
          company_id: scope.companyId,
          active: true,
        },
      })))
  )
    fail("Sucursal no disponible", 403, "FORBIDDEN");
}
module.exports = { payableScope, assertAccess, entryWhere, has };
