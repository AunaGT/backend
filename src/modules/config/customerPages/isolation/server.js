const fs = require("node:fs/promises"),
  path = require("node:path"),
  { randomUUID } = require("node:crypto");
const { readSandboxCapabilities } = require("./capabilities"),
  { compileCustomBlock } = require("./compile"),
  { writeArtifact } = require("./artifactStore");
const { readDraftAsset } = require("../assets"),
  { authorize } = require("../permissions"),
  { fail, keys } = require("../validationHelpers"),
  { getDraft } = require("../service");
async function serverCapabilities() {
  const root = process.env.PORTAL_SANDBOX_ARTIFACT_ROOT;
  let storeReady = false;
  try {
    if (path.isAbsolute(root)) {
      await fs.access(root, fs.constants.W_OK);
      storeReady = (await fs.stat(root)).isDirectory();
    }
  } catch {
    /* Explicit readiness, never create infrastructure during a request. */
  }
  return readSandboxCapabilities({
    enabled: process.env.PORTAL_CUSTOM_CODE_ENABLED,
    origin: process.env.PORTAL_SANDBOX_ORIGIN,
    appOrigins: [...require("../../../../config/httpOrigins")],
    verifiedPolicyVersion: process.env.PORTAL_SANDBOX_VERIFIED_POLICY_VERSION,
    storeReady,
  });
}
async function tenantCapabilities(db, scope) {
  const global = await serverCapabilities(),
    policy = await db.portalCodePolicy.findFirst({
      where: { company_id: scope.companyId },
    });
  return {
    ...global,
    codeEnabled: policy?.enabled === true,
    policyRevision: policy?.revision || 0,
  };
}
async function assetData(db, scope, design) {
  const out = {};
  let bytes = 0;
  for (const [key, r] of Object.entries(design.resources)) {
    if (!r.assetId) continue;
    const buffer = await readDraftAsset(db, scope, r.assetId);
    bytes += buffer.length;
    if (bytes > 6 * 1024 * 1024)
      throw fail(
        422,
        "resources",
        "El código admite hasta 6 MiB de imágenes normalizadas",
      );
    out[key] = "data:image/png;base64," + buffer.toString("base64");
  }
  return out;
}
async function prepareArtifacts(db, scope, design) {
  authorize(scope, "code");
  const capability = await tenantCapabilities(db, scope);
  if (!capability.ready || !capability.codeEnabled)
    throw fail(
      503,
      "customBlocks",
      capability.reason || "Habilita el código visual en la empresa",
    );
  const images = await assetData(db, scope, design),
    artifacts = {};
  for (const [key, block] of Object.entries(design.customBlocks)) {
    const compiled = compileCustomBlock(block, {
      assetData: images,
      channelId: "channel-" + randomUUID(),
    });
    await writeArtifact(process.env.PORTAL_SANDBOX_ARTIFACT_ROOT, compiled);
    artifacts[key] = {
      url: capability.origin + "/artifacts/" + compiled.sha256,
      hash: compiled.sha256,
      channelId: compiled.channelId,
    };
  }
  return artifacts;
}
async function validateCode(db, scope, id, input) {
  authorize(scope, "code");
  keys(input, ["blockId", "block", "resources"], "input");
  const { validateDesign } = require("../validate"),
    record = await getDraft(db, scope, id),
    design = structuredClone(record.design);
  design.customBlocks = { [input.blockId]: input.block };
  design.resources = input.resources || {};
  design.nodes = [];
  design.savedSections = [];
  validateDesign(design);
  const compiled = compileCustomBlock(input.block, {
    assetData: await assetData(db, scope, design),
    channelId: "channel-validation",
  });
  return { diagnostics: compiled.diagnostics, hash: compiled.sha256 };
}
async function previewCode(db, scope, id, input) {
  authorize(scope, "code");
  keys(input, ["blockId", "expectedRevision"], "input");
  const r = await getDraft(db, scope, id);
  if (r.revision !== input.expectedRevision)
    throw fail(
      409,
      "expectedRevision",
      "Guarda y revisa el borrador antes de probar",
    );
  if (!Object.hasOwn(r.design.customBlocks, input.blockId))
    throw fail(404, "blockId", "Bloque no disponible");
  const artifacts = await prepareArtifacts(db, scope, {
    ...r.design,
    customBlocks: { [input.blockId]: r.design.customBlocks[input.blockId] },
  });
  return artifacts[input.blockId];
}
async function setCodePolicy(db, scope, input) {
  authorize(scope, "code");
  keys(input, ["enabled", "expectedRevision"], "input");
  if (
    typeof input.enabled !== "boolean" ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  )
    throw fail(422, "policy", "Política no válida");
  return db.$transaction(async (tx) => {
    if (tx.$executeRaw)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`portal:${scope.companyId}`},0))`;
    const current = await tx.portalCodePolicy.findFirst({
      where: { company_id: scope.companyId },
    });
    if ((current?.revision || 0) !== input.expectedRevision)
      throw fail(409, "policy", "La política cambió; vuelve a cargar");
    const data = {
      company_id: scope.companyId,
      enabled: input.enabled,
      revision: input.expectedRevision + 1,
      updated_by: scope.actorId,
      updated_at: new Date(),
    };
    await tx.portalCodePolicy.upsert({
      where: { company_id: scope.companyId },
      create: data,
      update: data,
    });
    return { enabled: input.enabled, revision: data.revision };
  });
}
module.exports = {
  serverCapabilities,
  tenantCapabilities,
  prepareArtifacts,
  validateCode,
  previewCode,
  setCodePolicy,
};
