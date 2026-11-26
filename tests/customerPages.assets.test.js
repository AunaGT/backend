const test = require("node:test"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto"),
  sharp = require("sharp");
const { fixture, scope } = require("./helpers/customerPagesDb"),
  service = require("../src/modules/config/customerPages/service");
test("normalized portal images use a separate private store and preserve tenant ownership", async () => {
  const {
      uploadAsset,
      readDraftAsset,
    } = require("../src/modules/config/customerPages/assets"),
    f = fixture(),
    objects = new Map(),
    store = {
      upload: async (path, buffer) => {
        objects.set(path, buffer);
        return {};
      },
      download: async (path) => ({ data: new Blob([objects.get(path)]) }),
      remove: async (paths) => {
        paths.forEach((p) => objects.delete(p));
      },
    };
  const r = await service.createDraft(f.db, scope, {
      name: "Fotos",
      documentType: "QUOTE",
      baseId: "CLASSIC",
      requestId: randomUUID(),
    }),
    buffer = await sharp({
      create: { width: 20, height: 10, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
  const out = await uploadAsset(
    f.db,
    scope,
    {
      templateId: r.id,
      expectedRevision: 1,
      file: { mimetype: "image/png", buffer },
    },
    store,
  );
  assert.equal(out.revision, 2);
  assert.equal(out.width, 20);
  assert.equal(f.assets.length, 1);
  assert.ok((await readDraftAsset(f.db, scope, out.id, store)).length > 0);
  await assert.rejects(
    () =>
      readDraftAsset(f.db, { ...scope, companyId: "company-b" }, out.id, store),
    (e) => e.status === 404,
  );
});
test("bad image input and stale revision cannot create portal assets", async () => {
  const { uploadAsset } = require("../src/modules/config/customerPages/assets"),
    f = fixture(),
    r = await service.createDraft(f.db, scope, {
      name: "Fotos",
      documentType: "QUOTE",
      baseId: "CLASSIC",
      requestId: randomUUID(),
    }),
    store = {
      upload: async () => {
        throw Error("must not upload");
      },
    };
  for (const file of [
    { mimetype: "image/svg+xml", buffer: Buffer.from("<svg/>") },
    { mimetype: "image/png", buffer: Buffer.from("not a png") },
  ])
    await assert.rejects(
      () =>
        uploadAsset(
          f.db,
          scope,
          { templateId: r.id, expectedRevision: 1, file },
          store,
        ),
      (e) => e.status === 400,
    );
  await assert.rejects(
    () =>
      uploadAsset(
        f.db,
        scope,
        { templateId: r.id, expectedRevision: 99, file: {} },
        store,
      ),
    (e) => e.status === 409,
  );
  assert.equal(f.assets.length, 0);
});
test("oversized images, exhausted quota and uploads racing with edits leave no objects", async () => {
  const {
      uploadAsset,
      readDraftAsset,
    } = require("../src/modules/config/customerPages/assets"),
    f = fixture(),
    r = await service.createDraft(f.db, scope, {
      name: "Fotos",
      documentType: "QUOTE",
      requestId: randomUUID(),
    });
  const objects = new Map(),
    store = {
      upload: async (p, b) => {
        objects.set(p, b);
        return {};
      },
      remove: async (paths) => {
        paths.forEach((p) => objects.delete(p));
      },
    },
    buffer = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
  await assert.rejects(
    () =>
      uploadAsset(
        f.db,
        scope,
        {
          templateId: r.id,
          expectedRevision: 1,
          file: {
            mimetype: "image/png",
            buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
          },
        },
        store,
      ),
    (e) => e.status === 413,
  );
  const large = await sharp({
    create: { width: 5001, height: 4000, channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    () =>
      uploadAsset(
        f.db,
        scope,
        {
          templateId: r.id,
          expectedRevision: 1,
          file: { mimetype: "image/png", buffer: large },
        },
        store,
      ),
    (e) => e.status === 400,
  );
  f.assets.push({
    id: "existing",
    company_id: scope.companyId,
    bytes: 100 * 1024 * 1024,
    path: "other-company/secret.png",
  });
  await assert.rejects(
    () =>
      uploadAsset(
        f.db,
        scope,
        {
          templateId: r.id,
          expectedRevision: 1,
          file: { mimetype: "image/png", buffer },
        },
        store,
      ),
    (e) => e.status === 409,
  );
  assert.equal(objects.size, 0);
  await assert.rejects(
    () => readDraftAsset(f.db, scope, "existing", store),
    (e) => e.status === 404,
  );
  f.assets.pop();
  store.upload = async (p, b) => {
    objects.set(p, b);
    f.templates[0].revision++;
    return {};
  };
  await assert.rejects(
    () =>
      uploadAsset(
        f.db,
        scope,
        {
          templateId: r.id,
          expectedRevision: 1,
          file: { mimetype: "image/png", buffer },
        },
        store,
      ),
    (e) => e.status === 409,
  );
  assert.equal(objects.size, 0);
});
