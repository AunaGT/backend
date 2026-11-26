const { requireCompany } = require("../../../middlewares/tenant");
const { isSystemAdmin } = require("../../users/roles/policy");
function scope(req) {
  return {
    companyId: requireCompany(req),
    actorId: req.user?.sub,
    permissions: req.user?.permissions || [],
    isAdmin: isSystemAdmin(req.user?.role),
  };
}
module.exports = { scope };
