const test = require("node:test"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto"),
  { fixture, scope } = require("./helpers/customerPagesDb");
const service = require("../src/modules/config/customerPages/service");
test('saving a section projects only its reachable code/images and remaps parsed image attributes on insertion',async()=>{
 const {saveSection,insertSection}=require('../src/modules/config/customerPages/sections'),{compileCustomBlock}=require('../src/modules/config/customerPages/isolation/compile'),f=fixture(),coder={...scope,permissions:['customer_pages.manage','customer_pages.code']},r=await service.createDraft(f.db,scope,{name:'Secciones',documentType:'QUOTE',requestId:randomUUID()})
 const node={id:'custom',type:'CustomVisual',props:{blockId:'visual'},styles:{desktop:{},tablet:{},mobile:{}},visibility:{},children:[]},blocks={visual:{html:'<img data-asset="logo">',css:'',js:'',fallbackText:'Logo'},unrelated:{html:'<p>Otro código</p>',css:'',js:'',fallbackText:'Otro'}}
 const saved=await saveSection(f.db,coder,{name:'Encabezado',documentType:'QUOTE',nodes:[node],resources:{logo:{assetId:'',alt:'Logo'},unrelated:{assetId:'',alt:'Otra imagen'}},customBlocks:blocks})
 assert.deepEqual(Object.keys(saved.design.resources),['logo']);assert.deepEqual(Object.keys(saved.design.customBlocks),['visual'])
 const out=insertSection(r.design,saved),block=out.customBlocks[out.nodes.at(-1).props.blockId],assetKey=Object.keys(out.resources)[0],png='data:image/png;base64,iVBORw0KGgo='
 assert.doesNotThrow(()=>compileCustomBlock(block,{assetData:{[assetKey]:png},channelId:'channel-copy'}))
})
test("exported resources are logical and import never trusts a foreign asset ID or publishes", async () => {
  const {
      exportDesign,
      importDesign,
    } = require("../src/modules/config/customerPages/transfer"),
    f = fixture(),
    r = await service.createDraft(f.db, scope, {
      name: "Original",
      documentType: "QUOTE",
      baseId: "CLASSIC",
      requestId: randomUUID(),
    });
  r.design.resources.photo = { assetId: "private-storage-id", alt: "Foto" };
  await service.saveDraft(f.db, scope, r.id, {
    name: r.name,
    design: r.design,
    expectedRevision: 1,
    requestId: randomUUID(),
  });
  const out = await exportDesign(f.db, scope, r.id);
  assert.equal(out.json.includes("private-storage-id"), false);
  const imported = await importDesign(f.db, scope, {
    name: "Importada",
    documentType: "QUOTE",
    source: out.json,
    requestId: randomUUID(),
  });
  assert.notEqual(imported.id, r.id);
  assert.equal(imported.design.resources.photo.assetId, "");
  assert.equal(f.defaults.length, 0);
  const attack = JSON.parse(out.json);
  attack.design.resources.photo.assetId = "other-company-known-id";
  await assert.rejects(
    () =>
      importDesign(f.db, scope, {
        name: "Ataque",
        documentType: "QUOTE",
        source: JSON.stringify(attack),
        requestId: randomUUID(),
      }),
    (e) => e.status === 422,
  );
});
test("saved sections are copied with fresh node identifiers and stay within their company", async () => {
  const {
      saveSection,
      insertSection,
      listSections,
    } = require("../src/modules/config/customerPages/sections"),
    f = fixture(),
    r = await service.createDraft(f.db, scope, {
      name: "Secciones",
      documentType: "QUOTE",
      baseId: "CLASSIC",
      requestId: randomUUID(),
    });
  const nodes = [
    {
      id: "intro",
      type: "Text",
      props: { text: "Hola" },
      styles: { desktop: {}, tablet: {}, mobile: {} },
      visibility: {},
      children: [],
    },
  ];
  const saved = await saveSection(f.db, scope, {
    name: "Bienvenida",
    documentType: "QUOTE",
    nodes,
  });
  const out = insertSection(r.design, saved);
  assert.notEqual(out.nodes.at(-1).id, "intro");
  assert.equal(out.nodes.at(-1).props.text, "Hola");
  assert.equal(
    (await listSections(f.db, { ...scope, companyId: "other" })).length,
    0,
  );
});
test("a section with long logical image keys gets valid fresh references on insertion", async () => {
  const {
      saveSection,
      insertSection,
    } = require("../src/modules/config/customerPages/sections"),
    f = fixture(),
    r = await service.createDraft(f.db, scope, {
      name: "Secciones",
      documentType: "QUOTE",
      requestId: randomUUID(),
    }),
    key = "photo-" + randomUUID();
  const image = {
    id: "photo",
    type: "Image",
    props: { resource: key },
    styles: { desktop: {}, tablet: {}, mobile: {} },
    visibility: {},
    children: [],
  };
  const section = await saveSection(f.db, scope, {
    name: "Foto",
    documentType: "QUOTE",
    nodes: [image],
    resources: { [key]: { assetId: "", alt: "Foto" } },
  });
  assert.doesNotThrow(() => insertSection(r.design, section));
});
