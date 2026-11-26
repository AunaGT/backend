function readSandboxCapabilities({
  enabled,
  origin,
  appOrigins = [],
  verifiedPolicyVersion,
  storeReady,
} = {}) {
  const blocked = (reason) => ({ ready: false, reason, policyVersion: 1 });
  if (enabled !== "true")
    return blocked("El administrador no ha habilitado el código visual");
  let url;
  try {
    url = new URL(origin);
  } catch {
    return blocked("Falta el origen HTTPS de aislamiento");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    !appOrigins.length ||
    appOrigins.some((app) => {
      try {
        return (
          new URL(app).origin === url.origin ||
          new URL(app).hostname === url.hostname
        );
      } catch {
        return true;
      }
    })
  )
    return blocked(
      "El origen debe ser HTTPS, independiente y sin rutas ni credenciales",
    );
  if (verifiedPolicyVersion !== "1")
    return blocked(
      "Falta verificar el aislamiento y sus cabeceras en el despliegue",
    );
  if (storeReady !== true)
    return blocked("El almacenamiento de artefactos no está preparado");
  return { ready: true, origin: url.origin, policyVersion: 1 };
}
module.exports = { readSandboxCapabilities };
