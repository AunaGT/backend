const { validateDesign } = require("../modules/config/customerPages/validate");
const {
  fail,
  keyName,
} = require("../modules/config/customerPages/validationHelpers");
const { privateStore } = require("../modules/config/customerPages/assets");
async function publicVersion(db, { companyId, documentType, versionId }) {
  // Old deployments remain on the existing page until the additive migration/client is installed.
  if (!db.portalTemplateDefault) return null;
  const active = versionId ? { version_id: versionId } : await db.portalTemplateDefault.findFirst({
    where: { company_id: companyId, document_type: documentType },
  });
  if (!active) return null;
  const version = await db.portalTemplateVersion.findFirst({
    where: { company_id: companyId, id: active.version_id, state: "PUBLISHED" },
  });
  if (!version || version.renderer_version !== 1) return null;
  const template = await db.portalTemplate.findFirst({
    where: {
      company_id: companyId,
      id: version.template_id,
      state: "ACTIVE",
      document_type: documentType,
    },
  });
  if (!template) return null;
  const ids = Object.values(version.design.resources || {}).map(
    (r) => r.assetId,
  );
  const assets = ids.length
    ? await db.portalAsset.findMany({
        where: { company_id: companyId, id: { in: ids } },
        take: 20,
      })
    : [];
  try {
    validateDesign(version.design, { mode: "publish", documentType, assets });
    return version;
  } catch {
    return null;
  }
}
function serializePortalForPublic(version, capabilities = {}) {
  const design = structuredClone(version.design);
  design.savedSections = [];
  design.customBlocks = Object.fromEntries(
    Object.entries(design.customBlocks).map(([key, b]) => [
      key,
      { html: "", css: "", js: "", fallbackText: b.fallbackText },
    ]),
  );
  for (const [key, r] of Object.entries(design.resources)) r.assetId = key;
  return {
    versionId: version.id,
    rendererVersion: 1,
    designHash: version.design_hash,
    design,
    customCodeEnabled:
      capabilities.ready === true && capabilities.codeEnabled === true,
    customArtifacts:
      capabilities.ready === true && capabilities.codeEnabled === true
        ? version.custom_artifacts || {}
        : {},
  };
}
async function resolvePublicPortal(db, input) {
  try {
    return await resolveAvailablePortal(db, input);
  } catch (error) {
    // Only optional portal storage degrades; document/token/module authorization is outside this resolver.
    if (!["P2021", "P2022", "P1001", "P1002", "P1008", "P1017", "P2024"].includes(error.code)) throw error;
    console.warn("[customer-pages] fallback to standard page", { code: error.code });
    return null;
  }
}
async function resolveAvailablePortal(db, input) {
  const version = await publicVersion(db, input);
  if (!version) return null;
  const capabilities = Object.keys(version.custom_artifacts || {}).length
    ? await require("../modules/config/customerPages/isolation/server").tenantCapabilities(
        db,
        { companyId: input.companyId },
      )
    : {};
  const safe = serializePortalForPublic(version, capabilities);
  for (const artifact of Object.values(safe.customArtifacts))
    try {
      const u = new URL(artifact.url);
      if (
        u.origin !== capabilities.origin ||
        u.pathname !== "/artifacts/" + artifact.hash ||
        u.search ||
        u.hash
      )
        throw Error();
    } catch {
      safe.customArtifacts = {};
      safe.customCodeEnabled = false;
    }
  return safe;
}
async function readPublicPortalAsset(
  db,
  { documentType, publicToken, versionId, assetKey },
  { getModuleBlock, store } = {},
) {
  if (
    !["QUOTE", "ORDER"].includes(documentType) ||
    typeof publicToken !== "string" ||
    !publicToken ||
    publicToken.length > 200 ||
    typeof versionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(versionId) ||
    !keyName(assetKey)
  )
    throw fail(404, "asset", "Imagen no disponible");
  const doc = await db.commercialDocument.findFirst({
    where: { public_token: publicToken, doc_type: documentType },
    select: { status: true, branch: { select: { company_id: true } } },
  });
  if (!doc?.branch?.company_id)
    throw fail(404, "asset", "Imagen no disponible");
  const companyId = doc.branch.company_id;
  const block = await (
    getModuleBlock ||
    require("../modules/platform/service").getCompanyModuleBlock
  )(companyId, documentType === "QUOTE" ? "quotes" : "orders");
  if (block) throw fail(403, "asset", "Documento no disponible");
  if (documentType === "QUOTE" && ["DRAFT", "CANCELLED"].includes(doc.status))
    throw fail(410, "asset", "Documento no disponible");
  const version = await publicVersion(db, { companyId, documentType, versionId }),
    id = version?.design.resources[assetKey]?.assetId;
  if (!id) throw fail(404, "asset", "Imagen no disponible");
  const row = await db.portalAsset.findFirst({
    where: { company_id: companyId, id },
  });
  if (!row || row.path !== `${companyId}/assets/${row.id}.png`)
    throw fail(404, "asset", "Imagen no disponible");
  const result = await (store || (await privateStore())).download(row.path);
  if (result.error || !result.data)
    throw fail(503, "asset", "Imagen temporalmente no disponible");
  return {
    buffer: Buffer.from(await result.data.arrayBuffer()),
    mime: "image/png",
    hash: row.sha256,
  };
}
module.exports = {
  resolvePublicPortal,
  readPublicPortalAsset,
  serializePortalForPublic,
  publicVersion,
};
