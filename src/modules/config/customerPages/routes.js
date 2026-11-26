const { Router } = require("express"),
  multer = require("multer");
const service = require("./service"),
  assets = require("./assets"),
  transfer = require("./transfer"),
  sections = require("./sections"),
  publication = require("./publication");
const { schemaManifest } = require("./schema"),
  { resolveBase } = require("./bases"),
  { authorize } = require("./permissions");
const isolation = require("./isolation/server");
function createRouter(options = {}) {
  const router = Router(),
    origins = new Set(
      options.allowedOrigins || require("../../../config/httpOrigins"),
    );
  const database = () =>
    options.db || require("../../../models/prisma").prismaTransaction;
  const scope = options.scope || require("./scope").scope;
  const handler =
    (run, status = 200) =>
    async (req, res, next) => {
      try {
        const s = scope(req);
        authorize(s);
        res.set("Cache-Control", "private, no-store");
        const out = await run(req, s, res);
        if (!res.headersSent) res.status(status).json(out);
      } catch (error) {
        if (error.status)
          return res
            .status(error.status)
            .json({
              message: error.message,
              code: error.code,
              diagnostics: error.diagnostics,
            });
        next(error);
      }
    };
  router.use(
    options.auth || require("../../../middlewares/autenticacion").Auth,
  );
  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    const origin = req.get("Origin"),
      cookie = !!req.get("Cookie");
    if (
      origin
        ? origins.has(origin)
        : !cookie && /^Bearer\s+\S+$/i.test(req.get("Authorization") || "")
    )
      return next();
    res
      .status(403)
      .json({ message: "Origen no permitido para modificar páginas" });
  });
  const capabilities = async (s) => ({
    ...(await isolation.tenantCapabilities(database(), s)),
    compile: (design) => isolation.prepareArtifacts(database(), s, design),
    current: () => isolation.tenantCapabilities(database(), s),
  });
  router.get(
    "/schema",
    handler(async (_r, s) => ({
      ...schemaManifest,
      bases: Object.fromEntries(
        ["QUOTE", "ORDER"].map((type) => [
          type,
          Object.fromEntries(
            ["CLASSIC", "CATALOG", "SERVICES"].map((base) => [
              base,
              resolveBase(type, base),
            ]),
          ),
        ]),
      ),
      capabilities: await isolation.tenantCapabilities(database(), s),
    })),
  );
  router.put(
    "/code-policy",
    handler((r, s) => isolation.setCodePolicy(database(), s, r.body)),
  );
  router.get(
    "/",
    handler((r, s) => service.listTemplates(database(), s, r.query)),
  );
  router.post(
    "/",
    handler((r, s) => service.createDraft(database(), s, r.body), 201),
  );
  router.post(
    "/import",
    handler((r, s) => transfer.importDesign(database(), s, r.body), 201),
  );
  router.get(
    "/assets",
    handler((r, s) => assets.listAssets(database(), s, r.query)),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2, fieldSize: 200 },
  });
  router.post(
    "/assets",
    upload.single("image"),
    handler(
      (r, s) =>
        assets.uploadAsset(database(), s, {
          templateId: r.body.templateId,
          expectedRevision: Number(r.body.expectedRevision),
          file: r.file,
        }),
      201,
    ),
  );
  router.get(
    "/assets/:id",
    handler(async (r, s, res) =>
      res
        .type("image/png")
        .set("X-Content-Type-Options", "nosniff")
        .send(await assets.readDraftAsset(database(), s, r.params.id)),
    ),
  );
  router.get(
    "/sections",
    handler((r, s) => sections.listSections(database(), s)),
  );
  router.post(
    "/sections",
    handler((r, s) => sections.saveSection(database(), s, r.body), 201),
  );
  router.get(
    "/:id/export",
    handler((r, s) => transfer.exportDesign(database(), s, r.params.id)),
  );
  router.get(
    "/:id/versions",
    handler((r, s) =>
      publication.listVersions(database(), s, r.params.id, r.query),
    ),
  );
  router.get(
    "/:id/versions/:versionId",
    handler((r, s) =>
      publication.getVersion(database(), s, r.params.id, r.params.versionId),
    ),
  );
  router.get(
    "/:id",
    handler(async (r, s) => ({
      ...(await service.getDraft(database(), s, r.params.id)),
      capabilities: await isolation.tenantCapabilities(database(), s),
    })),
  );
  router.post(
    "/:id/source-compile",
    handler((r, s) => service.compileSource(database(), s, r.params.id, r.body)),
  );
  router.post(
    "/:id/code-validate",
    handler((r, s) =>
      isolation.validateCode(database(), s, r.params.id, r.body),
    ),
  );
  const codeLimit = require("express-rate-limit").rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      message: "Espera un minuto antes de crear más pruebas de código",
    },
  });
  router.post(
    "/:id/code-preview",
    codeLimit,
    handler((r, s) =>
      isolation.previewCode(database(), s, r.params.id, r.body),
    ),
  );
  router.put(
    "/:id",
    handler(async (r, s) => ({
      ...(await service.saveDraft(database(), s, r.params.id, r.body)),
      capabilities: await isolation.tenantCapabilities(database(), s),
    })),
  );
  router.post(
    "/:id/duplicate",
    handler(
      (r, s) => service.duplicateTemplate(database(), s, r.params.id, r.body),
      201,
    ),
  );
  router.post(
    "/:id/publish",
    handler(async (r, s) =>
      publication.publishTemplate(
        database(),
        s,
        r.params.id,
        r.body,
        await capabilities(s),
      ),
    ),
  );
  router.post(
    "/:id/restore",
    handler((r, s) =>
      publication.restoreVersion(database(), s, r.params.id, r.body),
    ),
  );
  router.post(
    "/:id/activate",
    handler(async (r, s) =>
      publication.activateVersion(
        database(),
        s,
        r.params.id,
        r.body,
        await capabilities(s),
      ),
    ),
  );
  router.post(
    "/:id/archive",
    handler((r, s) =>
      publication.archiveTemplate(database(), s, r.params.id, r.body),
    ),
  );
  router.use((error, _req, res, next) => {
    if (error instanceof multer.MulterError)
      return res
        .status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
        .json({ message: "Carga de imagen no válida; máximo 5 MiB" });
    next(error);
  });
  return router;
}
module.exports = { createRouter };
