const { fail } = require("./validationHelpers");
const permissions = ["view", "manage", "publish", "code"].map((action) => ({
  code: "customer_pages." + action,
  name: {
    view: "Ver páginas para clientes",
    manage: "Editar páginas para clientes",
    publish: "Publicar páginas para clientes",
    code: "Administrar código de páginas para clientes",
  }[action],
  description:
    "Personalización de páginas compartidas; no concede acceso a documentos comerciales",
}));
function authorize(scope, action = "view") {
  if (!scope?.companyId || !scope.actorId)
    throw fail(400, "scope", "Selecciona una empresa");
  const owned = new Set(scope.permissions || []);
  if (
    !scope.isAdmin &&
    !owned.has("customer_pages." + action) &&
    !(
      action === "view" &&
      ["manage", "publish", "code"].some((p) =>
        owned.has("customer_pages." + p),
      )
    )
  )
    throw fail(
      403,
      "permission",
      "No tienes permiso para esta acción",
      "PORTAL_FORBIDDEN",
    );
  return { company_id: scope.companyId };
}
module.exports = { permissions, authorize };
