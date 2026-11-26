const test = require("node:test"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto"),
  { fixture, scope } = require("./helpers/customerPagesDb"),
  service = require("../src/modules/config/customerPages/service"),
  publication = require("../src/modules/config/customerPages/publication");
test('optional portal storage failures fall back without exposing query details, but unexpected errors remain visible',async t=>{
 const {resolvePublicPortal}=require('../src/services/customerPagesPublic'),f=fixture(),warnings=[];
 t.mock.method(console,'warn',(...args)=>warnings.push(args));
 f.db.portalTemplateDefault.findFirst=async()=>{throw Object.assign(Error('query includes public-token-SECRET'),{code:'P2021'})};
 assert.equal(await resolvePublicPortal(f.db,{companyId:scope.companyId,documentType:'QUOTE'}),null);
 assert.match(JSON.stringify(warnings),/P2021/);assert.doesNotMatch(JSON.stringify(warnings),/SECRET|query/);
 f.db.portalTemplateDefault.findFirst=async()=>{throw new TypeError('unexpected programmer error')};
 await assert.rejects(()=>resolvePublicPortal(f.db,{companyId:scope.companyId,documentType:'QUOTE'}),TypeError);
})
test("public projection resolves tenant default only and never includes draft, source or private asset identifiers", async () => {
  const {
      resolvePublicPortal,
    } = require("../src/services/customerPagesPublic"),
    f = fixture(),
    r = await service.createDraft(f.db, scope, {
      name: "Web",
      documentType: "QUOTE",
      requestId: randomUUID(),
    });
  assert.equal(
    await resolvePublicPortal(f.db, {
      companyId: scope.companyId,
      documentType: "QUOTE",
    }),
    null,
  );
  await publication.publishTemplate(
    f.db,
    { ...scope, permissions: ["customer_pages.publish"] },
    r.id,
    {
      expectedRevision: 1,
      expectedDesignHash: r.designHash,
      requestId: randomUUID(),
    },
  );
  const portal = await resolvePublicPortal(f.db, {
      companyId: scope.companyId,
      documentType: "QUOTE",
    }),
    json = JSON.stringify(portal);
  assert.ok(portal.versionId);
  assert.equal(portal.design.savedSections.length, 0);
  assert.deepEqual(portal.design.customBlocks, {});
  assert.doesNotMatch(json, /created_by|actor|template_id/);
  assert.equal(
    await resolvePublicPortal(f.db, {
      companyId: "other",
      documentType: "QUOTE",
    }),
    null,
  );
});
test("an asset requires a valid document token and a logical reference in that company’s published design", async () => {
  const {
      readPublicPortalAsset,
    } = require("../src/services/customerPagesPublic"),
    f = fixture(),
    r = await service.createDraft(f.db, scope, {
      name: "Web",
      documentType: "QUOTE",
      requestId: randomUUID(),
    });
  f.assets.push({
    id: "private-image",
    company_id: scope.companyId,
    template_id: r.id,
    path: `${scope.companyId}/assets/private-image.png`,
    sha256: "hash",
  });
  r.design.resources.cover = { assetId: "private-image", alt: "Portada" };
  const saved = await service.saveDraft(f.db, scope, r.id, {
    name: r.name,
    design: r.design,
    expectedRevision: 1,
    requestId: randomUUID(),
  });
  await publication.publishTemplate(
    f.db,
    { ...scope, permissions: ["customer_pages.publish"] },
    r.id,
    {
      expectedRevision: 2,
      expectedDesignHash: saved.designHash,
      requestId: randomUUID(),
    },
  );
  const docs = {
    "token-a": { status: "SENT", branch: { company_id: scope.companyId } },
    "token-b": { status: "SENT", branch: { company_id: "other" } },
    draft: { status: "DRAFT", branch: { company_id: scope.companyId } },
  };
  f.db.commercialDocument = {
    findFirst: async ({ where }) => docs[where.public_token] || null,
  };
  const options = {
    getModuleBlock: async () => null,
    store: { download: async () => ({ data: new Blob(["png"]) }) },
  };
  const versionId = f.defaults[0].version_id;
  const ok = await readPublicPortalAsset(
    f.db,
    { documentType: "QUOTE", publicToken: "token-a", versionId, assetKey: "cover" },
    options,
  );
  assert.equal(ok.buffer.toString(), "png");
  for (const input of [
    { publicToken: "token-b", assetKey: "cover" },
    { publicToken: "draft", assetKey: "cover" },
    { publicToken: "token-a", assetKey: "private-image" },
  ])
    await assert.rejects(
      () =>
        readPublicPortalAsset(
          f.db,
          { documentType: "QUOTE", versionId, ...input },
          options,
        ),
      (e) => [404, 410].includes(e.status),
    );
  await assert.rejects(
    () =>
      readPublicPortalAsset(
        f.db,
        { documentType: "QUOTE", publicToken: "token-a", versionId, assetKey: "cover" },
        {
          ...options,
          getModuleBlock: async () => ({ code: "MODULE_DISABLED" }),
        },
      ),
    (e) => e.status === 403,
  );
  const old = structuredClone(f.versions.find(v => v.id === versionId)), nextId = randomUUID();
  f.assets.push({ ...f.assets[0], id:'new-image', path:`${scope.companyId}/assets/new-image.png` });
  const next = structuredClone(old);next.id=nextId;next.design.resources.cover.assetId='new-image';f.versions.push(next);f.defaults[0].version_id=nextId;
  const pinned = {documentType:'QUOTE',publicToken:'token-a',versionId,assetKey:'cover'}, read = input => readPublicPortalAsset(f.db,input,{...options,store:{download:async path=>({data:new Blob([path])})}});
  assert.equal((await read(pinned)).buffer.toString(),`${scope.companyId}/assets/private-image.png`);
  f.defaults.splice(0);
  assert.equal((await read(pinned)).buffer.toString(),`${scope.companyId}/assets/private-image.png`);
  for (const [state, company_id, documentType] of [['DRAFT',scope.companyId,'QUOTE'],['PUBLISHED','other','QUOTE'],['PUBLISHED',scope.companyId,'ORDER']]) {
    const foreign={...structuredClone(old),id:randomUUID(),state,company_id};foreign.design.documentType=documentType;f.versions.push(foreign);
    await assert.rejects(()=>read({...pinned,versionId:foreign.id}),e=>e.status===404);
  }
  await assert.rejects(()=>read({...pinned,versionId:undefined}),e=>e.status===404);
});
