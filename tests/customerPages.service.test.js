const test = require("node:test"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto");
const load = () => require("../src/modules/config/customerPages/service");
const { fixture, scope } = require("./helpers/customerPagesDb");
test("managing visual design does not grant permission to modify executable source", async () => {
  const service = load(),
    f = fixture(),
    r = await service.createDraft(f.db, scope, {
      name: "Visual",
      documentType: "QUOTE",
      requestId: randomUUID(),
    });
  r.design.customBlocks.demo = {
    html: "<p>Hola</p>",
    css: "",
    js: "alert(1)",
    fallbackText: "Hola",
  };
  await assert.rejects(
    () =>
      service.saveDraft(f.db, scope, r.id, {
        name: r.name,
        design: r.design,
        expectedRevision: 1,
        requestId: randomUUID(),
      }),
    (e) => e.status === 403,
  );
});
test("creating and saving a draft is tenant-scoped, revisioned and never publishes", async () => {
  const f = fixture(),
    s = load(),
    r = await s.createDraft(f.db, scope, {
      name: "Mi cotización",
      documentType: "QUOTE",
      baseId: "CLASSIC",
      requestId: randomUUID(),
    });
  assert.equal(r.revision, 1);
  assert.equal(r.design.documentType, "QUOTE");
  assert.equal(f.versions[0].state, "DRAFT");
  const out = await s.saveDraft(f.db, scope, r.id, {
    name: "Nuevo nombre",
    design: r.design,
    expectedRevision: 1,
    requestId: randomUUID(),
  });
  assert.equal(out.revision, 2);
  assert.equal(out.name, "Nuevo nombre");
  assert.equal(f.audits.length, 2);
});
test("known other-company IDs cannot be read, overwritten or duplicated", async () => {
  const f = fixture(),
    s = load(),
    r = await s.createDraft(f.db, scope, {
      name: "Privada",
      documentType: "QUOTE",
      baseId: "CLASSIC",
      requestId: randomUUID(),
    }),
    other = { ...scope, companyId: "company-b" };
  for (const run of [
    () => s.getDraft(f.db, other, r.id),
    () =>
      s.saveDraft(f.db, other, r.id, {
        name: "Ataque",
        design: r.design,
        expectedRevision: 1,
        requestId: randomUUID(),
      }),
    () =>
      s.duplicateTemplate(f.db, other, r.id, {
        name: "Copia",
        expectedRevision: 1,
        requestId: randomUUID(),
      }),
  ])
    await assert.rejects(run, (e) => e.status === 404);
  assert.equal(f.templates.length, 1);
});
test("missing/stale revision and revoked permission do not write the draft", async () => {
  const f = fixture(),
    s = load(),
    r = await s.createDraft(f.db, scope, {
      name: "Privada",
      documentType: "ORDER",
      baseId: "CLASSIC",
      requestId: randomUUID(),
    });
  for (const [revision, status] of [
    [undefined, 428],
    [99, 409],
  ])
    await assert.rejects(
      () =>
        s.saveDraft(f.db, scope, r.id, {
          name: r.name,
          design: r.design,
          expectedRevision: revision,
          requestId: randomUUID(),
        }),
      (e) => e.status === status,
    );
  await assert.rejects(
    () => s.getDraft(f.db, { ...scope, permissions: [] }, r.id),
    (e) => e.status === 403,
  );
  assert.equal(f.templates[0].revision, 1);
});
test("write replay is scoped and rejects requestId reuse with a different payload", async () => {
  const f = fixture(),
    s = load(),
    input = {
      name: "Primera",
      documentType: "QUOTE",
      baseId: "CLASSIC",
      requestId: randomUUID(),
    };
  const a = await s.createDraft(f.db, scope, input),
    b = await s.createDraft(f.db, scope, input);
  assert.equal(a.id, b.id);
  assert.equal(f.templates.length, 1);
  await assert.rejects(
    () => s.createDraft(f.db, scope, { ...input, name: "Diferente" }),
    (e) => e.status === 409,
  );
  await assert.rejects(
    () => s.createDraft(f.db, { ...scope, permissions: [] }, input),
    (e) => e.status === 403,
  );
});
test("catalog distinguishes an active publication from the editable draft without returning design source", async () => {
  const f = fixture(),
    s = load(),
    r = await s.createDraft(f.db, scope, {
      name: "Web",
      documentType: "QUOTE",
      requestId: randomUUID(),
    }),
    p = require("../src/modules/config/customerPages/publication");
  await p.publishTemplate(
    f.db,
    { ...scope, permissions: ["customer_pages.publish"] },
    r.id,
    {
      expectedRevision: 1,
      expectedDesignHash: r.designHash,
      requestId: randomUUID(),
    },
  );
  const page = await s.listTemplates(f.db, scope);
  assert.equal(page.rows[0].active, true);
  assert.ok(page.rows[0].publishedVersionId);
  assert.equal(page.rows[0].design, undefined);
});
test('autosave replay does not retain a complete copy of every design in the receipt table',async()=>{const f=fixture(),s=load(),r=await s.createDraft(f.db,scope,{name:'Web',documentType:'QUOTE',requestId:randomUUID()}),input={name:'Guardado',design:r.design,expectedRevision:1,requestId:randomUUID()};const first=await s.saveDraft(f.db,scope,r.id,input),again=await s.saveDraft(f.db,scope,r.id,input);assert.deepEqual(first,again);assert.equal(f.receipts.at(-1).result.design,undefined)})
