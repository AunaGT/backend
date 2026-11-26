const test = require("node:test"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto"),
  { fixture, scope } = require("./helpers/customerPagesDb"),
  service = require("../src/modules/config/customerPages/service");
const publisher = {
  ...scope,
  permissions: [
    "customer_pages.manage",
    "customer_pages.publish",
    "customer_pages.code",
  ],
};
const command = (r) => ({
  expectedRevision: r.revision,
  expectedDesignHash: r.designHash,
  requestId: randomUUID(),
});
test("publication snapshots an immutable version and atomically selects one default under competing writes", async () => {
  const p = require("../src/modules/config/customerPages/publication"),
    f = fixture(),
    r = await service.createDraft(f.db, scope, {
      name: "Web",
      documentType: "QUOTE",
      requestId: randomUUID(),
    });
  const out = await Promise.allSettled([
    p.publishTemplate(f.db, publisher, r.id, command(r)),
    p.publishTemplate(f.db, publisher, r.id, command(r)),
  ]);
  assert.equal(out.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(f.defaults.length, 1);
  assert.equal(f.versions.filter((v) => v.state === "PUBLISHED").length, 1);
  assert.equal(f.versions.filter((v) => v.state === "DRAFT").length, 1);
  const saved = structuredClone(
      f.versions.find((v) => v.state === "PUBLISHED"),
    ),
    draft = await service.getDraft(f.db, scope, r.id);
  draft.design.theme.accent = "#111111";
  await service.saveDraft(f.db, scope, r.id, {
    name: draft.name,
    design: draft.design,
    expectedRevision: draft.revision,
    requestId: randomUUID(),
  });
  assert.deepEqual(
    f.versions.find((v) => v.id === saved.id),
    saved,
  );
});
test("stale previews, insufficient permissions, missing assets and unprepared custom code cannot publish", async () => {
  const p = require("../src/modules/config/customerPages/publication"),
    f = fixture(),
    r = await service.createDraft(f.db, scope, {
      name: "Web",
      documentType: "QUOTE",
      requestId: randomUUID(),
    });
  await assert.rejects(
    () => p.publishTemplate(f.db, scope, r.id, command(r)),
    (e) => e.status === 403,
  );
  await assert.rejects(
    () =>
      p.publishTemplate(f.db, publisher, r.id, {
        ...command(r),
        expectedDesignHash: "stale",
      }),
    (e) => e.status === 409,
  );
  r.design.resources.photo = { assetId: "foreign", alt: "Foto" };
  const a = await service.saveDraft(f.db, scope, r.id, {
    name: r.name,
    design: r.design,
    expectedRevision: 1,
    requestId: randomUUID(),
  });
  await assert.rejects(
    () => p.publishTemplate(f.db, publisher, r.id, command(a)),
    (e) => e.status === 422,
  );
  delete a.design.resources.photo;
  a.design.customBlocks.demo = {
    html: "<p>Visual</p>",
    css: "",
    js: "alert(1)",
    fallbackText: "Visual",
  };
  const b = await service.saveDraft(f.db, publisher, r.id, {
    name: r.name,
    design: a.design,
    expectedRevision: 2,
    requestId: randomUUID(),
  });
  await assert.rejects(
    () =>
      p.publishTemplate(f.db, publisher, r.id, {
        ...command(b),
        acknowledgedCodeHash: b.codeHash,
      }),
    (e) => e.status === 503,
  );
  assert.equal(f.defaults.length, 0);
});
test("restore is scoped, revisioned and creates a draft; archiving active design requires explicit fallback", async () => {
  const p = require("../src/modules/config/customerPages/publication"),
    f = fixture(),
    r = await service.createDraft(f.db, scope, {
      name: "Web",
      documentType: "ORDER",
      requestId: randomUUID(),
    });
  const published = await p.publishTemplate(f.db, publisher, r.id, command(r)),
    draft = await service.getDraft(f.db, scope, r.id);
  await assert.rejects(
    () =>
      p.restoreVersion(f.db, { ...publisher, companyId: "other" }, r.id, {
        versionId: published.versionId,
        expectedRevision: draft.revision,
        requestId: randomUUID(),
      }),
    (e) => e.status === 404,
  );
  const restored = await p.restoreVersion(f.db, publisher, r.id, {
    versionId: published.versionId,
    expectedRevision: draft.revision,
    requestId: randomUUID(),
  });
  assert.equal(restored.revision, draft.revision + 1);
  await assert.rejects(
    () =>
      p.archiveTemplate(f.db, publisher, r.id, {
        expectedRevision: restored.revision,
        requestId: randomUUID(),
      }),
    (e) => e.status === 409,
  );
  await p.archiveTemplate(f.db, publisher, r.id, {
    expectedRevision: restored.revision,
    requestId: randomUUID(),
    useAunaDefault: true,
  });
  assert.equal(f.defaults.length, 0);
  assert.ok(f.versions.some((v) => v.state === "PUBLISHED"));
});
test("history preview is tenant-scoped and inert even when a version contains an executable artifact", async () => {
  const p = require("../src/modules/config/customerPages/publication"),
    f = fixture(),
    r = await service.createDraft(f.db, scope, {
      name: "Web",
      documentType: "QUOTE",
      requestId: randomUUID(),
    }),
    version = await p.publishTemplate(f.db, publisher, r.id, command(r));
  const snapshot = await p.getVersion(f.db, scope, r.id, version.versionId);
  assert.equal(snapshot.customCodeEnabled, false);
  assert.deepEqual(snapshot.customArtifacts, {});
  await assert.rejects(
    () =>
      p.getVersion(
        f.db,
        { ...scope, companyId: "other" },
        r.id,
        version.versionId,
      ),
    (e) => e.status === 404,
  );
});
test('quote and order history each identify their own active version',async()=>{const p=require('../src/modules/config/customerPages/publication'),f=fixture();for(const documentType of ['QUOTE','ORDER']){const r=await service.createDraft(f.db,scope,{name:documentType,documentType,requestId:randomUUID()});await p.publishTemplate(f.db,publisher,r.id,command(r));assert.equal((await p.listVersions(f.db,scope,r.id)).rows[0].active,true)}})
