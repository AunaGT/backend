const { randomUUID } = require("node:crypto");
const { normalizeImage } = require("../documentTemplates/assets");
const { assertSupabase } = require("../../../services/supabaseStorage");
const { authorize } = require("./permissions");
const { findTemplate, revision } = require("./service");
const { fail } = require("./validationHelpers");
const { audit } = require("./audit");
const BUCKET = "customer-page-assets";
async function privateStore() {
  const client = assertSupabase(),
    { data, error } = await client.storage.getBucket(BUCKET);
  if (error || data?.public !== false)
    throw fail(
      503,
      "assets",
      "El almacenamiento privado de páginas no está disponible",
    );
  return client.storage.from(BUCKET);
}
async function uploadAsset(
  db,
  scope,
  { templateId, expectedRevision, file },
  store,
) {
  authorize(scope, "manage");
  revision(expectedRevision);
  const template = await findTemplate(db, scope, templateId);
  if (template.revision !== expectedRevision || template.state !== "ACTIVE")
    throw fail(
      409,
      "expectedRevision",
      "El diseño cambió; recárgalo antes de subir la imagen",
    );
  const image = await normalizeImage(file),
    id = randomUUID(),
    path = `${scope.companyId}/assets/${id}.png`;
  store = store || (await privateStore());
  const uploaded = await store.upload(path, image.buffer, {
    upsert: false,
    contentType: "image/png",
    cacheControl: "0",
  });
  if (uploaded.error) throw fail(503, "assets", "No se pudo guardar la imagen");
  try {
    return await db.$transaction(async (tx) => {
      if (tx.$executeRaw)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`portal:${scope.companyId}`},0))`;
      const where = { company_id: scope.companyId },
        [count, size] = await Promise.all([
          tx.portalAsset.count({ where }),
          tx.portalAsset.aggregate({ where, _sum: { bytes: true } }),
        ]);
      if (
        count >= 500 ||
        (size._sum.bytes || 0) + image.buffer.length > 100 * 1024 * 1024
      )
        throw fail(
          409,
          "assets",
          "La biblioteca alcanzó su límite de 500 imágenes o 100 MiB",
        );
      const claim = await tx.portalTemplate.updateMany({
        where: {
          id: templateId,
          company_id: scope.companyId,
          revision: expectedRevision,
          state: "ACTIVE",
        },
        data: { revision: { increment: 1 } },
      });
      if (claim.count !== 1)
        throw fail(
          409,
          "expectedRevision",
          "El diseño cambió; la imagen no se adjuntó",
        );
      const row = await tx.portalAsset.create({
        data: {
          id,
          company_id: scope.companyId,
          template_id: templateId,
          path,
          sha256: image.sha256,
          width: image.width,
          height: image.height,
          bytes: image.buffer.length,
          created_by: scope.actorId,
        },
      });
      await audit(
        tx,
        scope,
        "UPLOAD_ASSET",
        templateId,
        expectedRevision + 1,
        image.sha256,
      );
      return {
        id: row.id,
        width: row.width,
        height: row.height,
        bytes: row.bytes,
        revision: expectedRevision + 1,
      };
    });
  } catch (error) {
    await store.remove([path]).catch(() => {});
    throw error;
  }
}
async function readDraftAsset(db, scope, id, store) {
  authorize(scope);
  if(typeof id!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))throw fail(404,'assets','Imagen no disponible');
  const row = await db.portalAsset.findFirst({
    where: { id, company_id: scope.companyId },
  });
  if (!row || row.path !== `${scope.companyId}/assets/${row.id}.png`)
    throw fail(404, "assets", "Imagen no disponible");
  const result = await (store || (await privateStore())).download(row.path);
  if (result.error || !result.data)
    throw fail(503, "assets", "No se pudo abrir la imagen");
  return Buffer.from(await result.data.arrayBuffer());
}
async function listAssets(db, scope, { page = 1, pageSize = 20 } = {}) {
  authorize(scope);
  page = Number(page);
  pageSize = Number(pageSize);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50
  )
    throw fail(422, "page", "Página no válida");
  const where = { company_id: scope.companyId },
    [rows, total] = await Promise.all([
      db.portalAsset.findMany({
        where,
        select: { id: true, width: true, height: true, bytes: true },
        orderBy: [{ created_at: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.portalAsset.count({ where }),
    ]);
  return {
    rows: rows.map(({ id, width, height, bytes }) => ({
      id,
      width,
      height,
      bytes,
    })),
    total,
    page,
    pageSize,
  };
}
module.exports = {
  uploadAsset,
  readDraftAsset,
  listAssets,
  privateStore,
  BUCKET,
};
