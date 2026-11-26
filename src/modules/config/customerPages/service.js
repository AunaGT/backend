const { randomUUID } = require("node:crypto");
const { authorize } = require("./permissions");
const { validateDesign } = require("./validate");
const { resolveBase } = require("./bases");
const { fail, hash, text, keys } = require("./validationHelpers");
const { audit } = require("./audit");
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw fail(
      428,
      "expectedRevision",
      "Recarga la versión antes de continuar",
    );
}
function nameOf(value) {
  text(value, "name", 150);
  if (!value.trim())
    throw fail(422, "name", "Escribe un nombre para el diseño");
  return value.trim();
}
async function command(db, scope, action, input, run) {
  if (!uuid(input.requestId))
    throw fail(422, "requestId", "Identificador de operación inválido");
  const inputHash = hash({ action, ...input });
  return db.$transaction(
    async (tx) => {
      if (tx.$executeRaw)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`portal:${scope.companyId}`},0))`;
      const old = await tx.portalWriteReceipt.findFirst({
        where: {
          company_id: scope.companyId,
          actor_id: scope.actorId,
          request_id: input.requestId,
        },
      });
      if (old) {
        if (old.input_hash !== inputHash)
          throw fail(
            409,
            "requestId",
            "Esta operación ya se utilizó con otros datos",
          );
        return action==='SAVE'?{...old.result,design:JSON.parse(JSON.stringify(input.design))}:old.result;
      }
      const result = await run(tx);
      // Autosave source is already authenticated by input_hash; do not duplicate it per keystroke batch.
      const stored=JSON.parse(JSON.stringify(result));if(action==='SAVE')delete stored.design;
      await tx.portalWriteReceipt.create({
        data: {
          company_id: scope.companyId,
          actor_id: scope.actorId,
          request_id: input.requestId,
          input_hash: inputHash,
          result: stored,
        },
      });
      return result;
    },
    { maxWait: 10000, timeout: 15000 },
  );
}
async function findTemplate(db, scope, id) {
  if (!uuid(id)) throw fail(404, "id", "Diseño no disponible");
  const row = await db.portalTemplate.findFirst({
    where: { id, company_id: scope.companyId },
  });
  if (!row) throw fail(404, "id", "Diseño no disponible");
  return row;
}
async function draftOf(db, scope, row) {
  return db.portalTemplateVersion.findFirst({
    where: { company_id: scope.companyId, template_id: row.id, state: "DRAFT" },
  });
}
function dto(row, version) {
  return {
    id: row.id,
    name: row.name,
    documentType: row.document_type,
    revision: row.revision,
    draftVersionId: version.id,
    design: version.design,
    designHash: version.design_hash,
    codeHash: version.code_hash,
    capabilities: {
      ready: false,
      reason: "El entorno de código aislado todavía no está preparado",
      policyVersion: 1,
    },
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
    state: row.state,
  };
}
async function getDraft(db, scope, id) {
  authorize(scope);
  const row = await findTemplate(db, scope, id),
    version = await draftOf(db, scope, row);
  if (!version)
    throw fail(409, "id", "Este diseño no tiene un borrador editable");
  return dto(row, version);
}
async function compileSource(db, scope, id, input) {
  authorize(scope, "manage");
  keys(input, ["design", "html", "css"], "source");
  const row = await findTemplate(db, scope, id);
  const baseDesign = validateDesign(input.design, { documentType: row.document_type }).design;
  const design = await require("./pageSource").compilePageSource({ ...input, baseDesign });
  return { design, diagnostics: [] };
}
async function createIn(tx, scope, input) {
  if (
    (await tx.portalTemplate.count({
      where: { company_id: scope.companyId, state: "ACTIVE" },
    })) >= 100
  )
    throw fail(409, "name", "La empresa alcanzó 100 diseños activos");
  const compiled = validateDesign(
      input.design || resolveBase(input.documentType, input.baseId),
    ),
    name = nameOf(input.name);
  if (Object.keys(compiled.design.customBlocks).length)
    authorize(scope, "code");
  const row = await tx.portalTemplate.create({
    data: {
      id: randomUUID(),
      company_id: scope.companyId,
      name,
      document_type: compiled.design.documentType,
      state: "ACTIVE",
      revision: 1,
      created_by: scope.actorId,
    },
  });
  const version = await tx.portalTemplateVersion.create({
    data: {
      id: randomUUID(),
      company_id: scope.companyId,
      template_id: row.id,
      number: 1,
      state: "DRAFT",
      design: compiled.design,
      design_hash: compiled.designHash,
      code_hash: compiled.codeHash,
      created_by: scope.actorId,
    },
  });
  await audit(tx, scope, "CREATE", row.id, 1, compiled.designHash);
  return dto(row, version);
}
async function createDraft(db, scope, input) {
  authorize(scope, "manage");
  keys(input, ["name", "documentType", "baseId", "requestId"], "input");
  return command(db, scope, "CREATE", input, (tx) =>
    createIn(tx, scope, input),
  );
}
async function saveDraft(db, scope, id, input) {
  authorize(scope, "manage");
  keys(input, ["name", "design", "expectedRevision", "requestId"], "input");
  const current = await findTemplate(db, scope, id);
  revision(input.expectedRevision);
  const compiled = validateDesign(input.design, {
      documentType: current.document_type,
    }),
    name = nameOf(input.name);
  return command(db, scope, "SAVE", { ...input, id }, async (tx) => {
    const old = await draftOf(tx, scope, current);
    if (!old) throw fail(409, "id", "Borrador no disponible");
    if (old.code_hash !== compiled.codeHash) authorize(scope, "code");
    const claim = await tx.portalTemplate.updateMany({
      where: {
        id,
        company_id: scope.companyId,
        revision: input.expectedRevision,
        state: "ACTIVE",
      },
      data: { name, revision: { increment: 1 } },
    });
    if (claim.count !== 1)
      throw fail(
        409,
        "expectedRevision",
        "Otra persona cambió este diseño. Tus cambios no se descartaron",
      );
    await tx.portalTemplateVersion.updateMany({
      where: { company_id: scope.companyId, id: old.id, state: "DRAFT" },
      data: {
        design: compiled.design,
        design_hash: compiled.designHash,
        code_hash: compiled.codeHash,
      },
    });
    await audit(
      tx,
      scope,
      "SAVE",
      id,
      input.expectedRevision + 1,
      compiled.designHash,
    );
    return dto(
      { ...current, name, revision: input.expectedRevision + 1 },
      {
        ...old,
        design: compiled.design,
        design_hash: compiled.designHash,
        code_hash: compiled.codeHash,
      },
    );
  });
}
async function duplicateTemplate(db, scope, id, input) {
  authorize(scope, "manage");
  keys(input, ["name", "expectedRevision", "requestId"], "input");
  const row = await findTemplate(db, scope, id);
  revision(input.expectedRevision);
  if (row.revision !== input.expectedRevision)
    throw fail(409, "expectedRevision", "El diseño cambió; recárgalo");
  const original = await draftOf(db, scope, row);
  return command(db, scope, "DUPLICATE", { ...input, id }, (tx) =>
    createIn(tx, scope, {
      ...input,
      documentType: row.document_type,
      design: original.design,
    }),
  );
}
async function listTemplates(
  db,
  scope,
  { type, page = 1, pageSize = 20, state = "ACTIVE" } = {},
) {
  const tenant = authorize(scope);
  page = Number(page);
  pageSize = Number(pageSize);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50 ||
    (type && !["QUOTE", "ORDER"].includes(type)) ||
    !["ACTIVE", "ARCHIVED"].includes(state)
  )
    throw fail(422, "filters", "Filtros o página inválidos");
  const where = { ...tenant, state, ...(type ? { document_type: type } : {}) },
    [rows, total] = await Promise.all([
      db.portalTemplate.findMany({
        where,
        orderBy: [{ updated_at: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          document_type: true,
          revision: true,
          state: true,
          updated_at: true,
        },
      }),
      db.portalTemplate.count({ where }),
    ]);
  const ids = rows.map((r) => r.id),
    [versions, defaults] = ids.length
      ? await Promise.all([
          db.portalTemplateVersion.findMany({
            where: {
              company_id: scope.companyId,
              template_id: { in: ids },
              state: "PUBLISHED",
            },
            select: { id: true, template_id: true, number: true },
            take: 5000,
          }),
          db.portalTemplateDefault.findMany({
            where: { company_id: scope.companyId },
            select: { version_id: true },
            take: 2,
          }),
        ])
      : [[], []];
  const latest = new Map();
  for (const v of versions)
    if (
      !latest.has(v.template_id) ||
      v.number > latest.get(v.template_id).number
    )
      latest.set(v.template_id, v);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      documentType: r.document_type,
      revision: r.revision,
      state: r.state,
      updatedAt: r.updated_at,
      publishedVersionId: latest.get(r.id)?.id || null,
      active: versions.some(
        (v) =>
          v.template_id === r.id && defaults.some((d) => d.version_id === v.id),
      ),
    })),
    total,
    page,
    pageSize,
  };
}
module.exports = {
  compileSource,
  createDraft,
  getDraft,
  saveDraft,
  listTemplates,
  duplicateTemplate,
  command,
  findTemplate,
  draftOf,
  dto,
  createIn,
  revision,
  nameOf,
};
