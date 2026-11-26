const { randomUUID } = require("node:crypto");
const { authorize } = require("./permissions");
const { validateDesign } = require("./validate");
const { command, findTemplate, draftOf, dto, revision } = require("./service");
const { fail, keys } = require("./validationHelpers");
const { audit } = require("./audit");
async function claim(tx, scope, id, expectedRevision) {
  revision(expectedRevision);
  const updated = await tx.portalTemplate.updateMany({
    where: {
      id,
      company_id: scope.companyId,
      state: "ACTIVE",
      revision: expectedRevision,
    },
    data: { revision: { increment: 1 } },
  });
  if (updated.count !== 1)
    throw fail(
      409,
      "expectedRevision",
      "El diseño cambió; guarda y revisa nuevamente",
    );
}
async function validated(tx, scope, version, capabilities = {}) {
  const assets = await tx.portalAsset.findMany({
    where: { company_id: scope.companyId },
    take: 500,
  });
  const compiled = validateDesign(version.design, { mode: "publish", assets });
  if (Object.keys(compiled.design.customBlocks).length) {
    authorize(scope, "code");
    const current = capabilities.current
      ? await capabilities.current()
      : capabilities;
    if (
      !current.ready ||
      !capabilities.compile ||
      !(await tx.portalCodePolicy.findFirst({
        where: { company_id: scope.companyId, enabled: true },
      }))
    )
      throw fail(
        503,
        "customBlocks",
        "El código visual necesita un entorno aislado verificado y habilitación de la empresa",
      );
  }
  return compiled;
}
async function selectDefault(tx, scope, row, versionId) {
  const key = { company_id: scope.companyId, document_type: row.document_type };
  await tx.portalTemplateDefault.upsert({
    where: { company_id_document_type: key },
    create: { ...key, version_id: versionId },
    update: { version_id: versionId },
  });
}
function published(version) {
  return {
    versionId: version.id,
    rendererVersion: version.renderer_version || 1,
    designHash: version.design_hash,
    design: version.design,
    customCodeEnabled: Object.keys(version.custom_artifacts || {}).length > 0,
    customArtifacts: version.custom_artifacts || {},
  };
}
async function publishTemplate(db, scope, id, input, capabilities = {}) {
  authorize(scope, "publish");
  keys(
    input,
    [
      "expectedRevision",
      "requestId",
      "expectedDesignHash",
      "acknowledgedCodeHash",
    ],
    "input",
  );
  revision(input.expectedRevision);
  const initialRow = await findTemplate(db, scope, id),
    initialDraft = await draftOf(db, scope, initialRow);
  if (!initialDraft || initialDraft.design_hash !== input.expectedDesignHash)
    throw fail(
      409,
      "expectedDesignHash",
      "La vista previa no corresponde al borrador actual",
    );
  const initial = await validated(db, scope, initialDraft, capabilities);
  if (
    Object.keys(initial.design.customBlocks).length &&
    initial.codeHash !== input.acknowledgedCodeHash
  )
    throw fail(
      422,
      "acknowledgedCodeHash",
      "Revisa y reconoce el código exacto antes de publicar",
    );
  // Artifact IO is prepared before the short database transaction; claims below recheck it.
  const preparedArtifacts = Object.keys(initial.design.customBlocks).length
    ? await capabilities.compile(initial.design)
    : {};
  return command(db, scope, "PUBLISH", { ...input, id }, async (tx) => {
    const row = await findTemplate(tx, scope, id),
      draft = await draftOf(tx, scope, row);
    if (!draft || draft.design_hash !== input.expectedDesignHash)
      throw fail(
        409,
        "expectedDesignHash",
        "La vista previa no corresponde al borrador actual",
      );
    const compiled = await validated(tx, scope, draft, capabilities);
    if (
      Object.keys(compiled.design.customBlocks).length &&
      compiled.codeHash !== input.acknowledgedCodeHash
    )
      throw fail(
        422,
        "acknowledgedCodeHash",
        "Revisa y reconoce el código exacto antes de publicar",
      );
    const count = await tx.portalTemplateVersion.count({
      where: { company_id: scope.companyId, template_id: id },
    });
    if (count >= 100)
      throw fail(
        409,
        "versions",
        "El diseño alcanzó 100 versiones; duplica para continuar",
      );
    const artifacts = preparedArtifacts;
    await claim(tx, scope, id, input.expectedRevision);
    const snapshot = {
      ...draft,
      design: compiled.design,
      design_hash: compiled.designHash,
      code_hash: compiled.codeHash,
      custom_artifacts: artifacts,
      state: "PUBLISHED",
      published_at: new Date(),
      acknowledged_code_hash: input.acknowledgedCodeHash || null,
      renderer_version: 1,
    };
    await tx.portalTemplateVersion.updateMany({
      where: { id: draft.id, company_id: scope.companyId, state: "DRAFT" },
      data: {
        state: "PUBLISHED",
        published_at: snapshot.published_at,
        custom_artifacts: artifacts,
        acknowledged_code_hash: snapshot.acknowledged_code_hash,
        renderer_version: 1,
      },
    });
    await tx.portalTemplateVersion.create({
      data: {
        id: randomUUID(),
        company_id: scope.companyId,
        template_id: id,
        number: draft.number + 1,
        state: "DRAFT",
        renderer_version: 1,
        design: compiled.design,
        design_hash: compiled.designHash,
        code_hash: compiled.codeHash,
        created_by: scope.actorId,
      },
    });
    await selectDefault(tx, scope, row, draft.id);
    await audit(
      tx,
      scope,
      "PUBLISH",
      id,
      input.expectedRevision + 1,
      compiled.designHash,
    );
    return published(snapshot);
  });
}
async function restoreVersion(db, scope, id, input) {
  authorize(scope, "manage");
  keys(input, ["versionId", "expectedRevision", "requestId"], "input");
  await findTemplate(db, scope, id);
  return command(db, scope, "RESTORE", { ...input, id }, async (tx) => {
    const row = await findTemplate(tx, scope, id),
      version = await tx.portalTemplateVersion.findFirst({
        where: {
          company_id: scope.companyId,
          template_id: id,
          id: input.versionId,
          state: "PUBLISHED",
        },
      });
    if (!version) throw fail(404, "versionId", "Versión no disponible");
    const compiled = validateDesign(version.design, {
      documentType: row.document_type,
    });
    if (Object.keys(compiled.design.customBlocks).length)
      authorize(scope, "code");
    await claim(tx, scope, id, input.expectedRevision);
    const draft = await draftOf(tx, scope, row);
    await tx.portalTemplateVersion.updateMany({
      where: { id: draft.id, company_id: scope.companyId, state: "DRAFT" },
      data: {
        design: compiled.design,
        design_hash: compiled.designHash,
        code_hash: compiled.codeHash,
      },
    });
    await audit(
      tx,
      scope,
      "RESTORE",
      id,
      input.expectedRevision + 1,
      compiled.designHash,
    );
    return dto(
      { ...row, revision: input.expectedRevision + 1 },
      {
        ...draft,
        design: compiled.design,
        design_hash: compiled.designHash,
        code_hash: compiled.codeHash,
      },
    );
  });
}
async function activateVersion(db, scope, id, input, capabilities = {}) {
  authorize(scope, "publish");
  keys(
    input,
    ["versionId", "expectedRevision", "requestId", "acknowledgedCodeHash"],
    "input",
  );
  await findTemplate(db, scope, id);
  return command(db, scope, "ACTIVATE", { ...input, id }, async (tx) => {
    const row = await findTemplate(tx, scope, id);
    if (input.versionId === null) {
      await claim(tx, scope, id, input.expectedRevision);
      await tx.portalTemplateDefault.deleteMany({
        where: {
          company_id: scope.companyId,
          document_type: row.document_type,
        },
      });
      await audit(tx, scope, "AUNA_DEFAULT", id, input.expectedRevision + 1);
      return { activeVersionId: null, revision: input.expectedRevision + 1 };
    }
    const version = await tx.portalTemplateVersion.findFirst({
      where: {
        company_id: scope.companyId,
        template_id: id,
        id: input.versionId,
        state: "PUBLISHED",
      },
    });
    if (!version) throw fail(404, "versionId", "Versión no disponible");
    const compiled = await validated(tx, scope, version, capabilities);
    if (
      Object.keys(compiled.design.customBlocks).length &&
      compiled.codeHash !== input.acknowledgedCodeHash
    )
      throw fail(
        422,
        "acknowledgedCodeHash",
        "Reconoce el código de esta versión",
      );
    await claim(tx, scope, id, input.expectedRevision);
    await selectDefault(tx, scope, row, version.id);
    await audit(
      tx,
      scope,
      "ACTIVATE",
      id,
      input.expectedRevision + 1,
      compiled.designHash,
    );
    return {
      activeVersionId: version.id,
      revision: input.expectedRevision + 1,
    };
  });
}
async function archiveTemplate(db, scope, id, input) {
  authorize(scope, "manage");
  keys(input, ["expectedRevision", "requestId", "useAunaDefault"], "input");
  await findTemplate(db, scope, id);
  return command(db, scope, "ARCHIVE", { ...input, id }, async (tx) => {
    const row = await findTemplate(tx, scope, id),
      versions = await tx.portalTemplateVersion.findMany({
        where: { company_id: scope.companyId, template_id: id },
        select: { id: true },
        take: 100,
      }),
      active = await tx.portalTemplateDefault.findFirst({
        where: {
          company_id: scope.companyId,
          version_id: { in: versions.map((v) => v.id) },
        },
      });
    if (active) {
      if (input.useAunaDefault !== true)
        throw fail(
          409,
          "useAunaDefault",
          "Selecciona otro diseño o confirma volver al diseño de Auna",
        );
      authorize(scope, "publish");
    }
    await claim(tx, scope, id, input.expectedRevision);
    if (active)
      await tx.portalTemplateDefault.deleteMany({
        where: { company_id: scope.companyId, version_id: active.version_id },
      });
    await tx.portalTemplate.updateMany({
      where: { id, company_id: scope.companyId },
      data: { state: "ARCHIVED" },
    });
    await audit(tx, scope, "ARCHIVE", id, input.expectedRevision + 1);
    return { state: "ARCHIVED", revision: input.expectedRevision + 1 };
  });
}
async function listVersions(db, scope, id, { page = 1 } = {}) {
  authorize(scope);
  const template=await findTemplate(db, scope, id);
  page = Number(page);
  if (!Number.isSafeInteger(page) || page < 1)
    throw fail(422, "page", "Página no válida");
  const where = {
      company_id: scope.companyId,
      template_id: id,
      state: "PUBLISHED",
    },
    [rows, total, active] = await Promise.all([
      db.portalTemplateVersion.findMany({
        where,
        orderBy: { number: "desc" },
        skip: (page - 1) * 20,
        take: 20,
        select: {
          id: true,
          number: true,
          published_at: true,
          design_hash: true,
          code_hash: true,
          created_by: true,
        },
      }),
      db.portalTemplateVersion.count({ where }),
      db.portalTemplateDefault.findFirst({
        where: { company_id: scope.companyId,document_type:template.document_type },
      }),
    ]);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      number: r.number,
      publishedAt: r.published_at,
      designHash: r.design_hash,
      codeHash: r.code_hash,
      authorId: r.created_by,
      active: r.id === active?.version_id,
    })),
    total,
    page,
  };
}
async function getVersion(db, scope, id, versionId) {
  authorize(scope);
  const row = await findTemplate(db, scope, id),
    version = await db.portalTemplateVersion.findFirst({
      where: {
        company_id: scope.companyId,
        template_id: id,
        id: versionId,
        state: "PUBLISHED",
      },
    });
  if (!version) throw fail(404, "versionId", "Versión no disponible");
  validateDesign(version.design, { documentType: row.document_type });
  return {
    ...published(version),
    customCodeEnabled: false,
    customArtifacts: {},
  };
}
module.exports = {
  publishTemplate,
  restoreVersion,
  activateVersion,
  archiveTemplate,
  listVersions,
  getVersion,
  published,
};
