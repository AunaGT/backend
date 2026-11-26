const test = require("node:test"),
  assert = require("node:assert/strict");
const load = () => require("../src/modules/config/customerPages/validate");
const node = (id, type = "Text", children = []) => ({
  id,
  type,
  props: {},
  styles: { desktop: {}, tablet: {}, mobile: {} },
  visibility: {},
  children,
});
const design = () => ({
  schemaVersion: 1,
  documentType: "QUOTE",
  theme: {},
  nodes: ["Identity", "Validity", "Items", "Summary", "QuoteResponse"].map((n) =>
    node(n, n),
  ),
  resources: {},
  savedSections: [],
  customBlocks: {},
});
test('quote validity cannot be omitted or hidden directly or through a conditional parent',()=>{
 const {resolveBase}=require('../src/modules/config/customerPages/bases'),{validateDesign}=load();
 const without=resolveBase('QUOTE');const remove=nodes=>nodes.filter(n=>n.type!=='Validity').map(n=>({...n,children:remove(n.children)}));without.nodes=remove(without.nodes);
 assert.throws(()=>validateDesign(without,{mode:'publish'}),e=>e.status===422);
 for(const ancestor of [false,true]) {
   const d=resolveBase('QUOTE'),find=nodes=>nodes.flatMap(n=>[n,...find(n.children)]),validity=find(d.nodes).find(n=>n.type==='Validity');
   if(ancestor){d.nodes=remove(d.nodes);d.nodes.push({...node('conditional','Section',[validity]),visibility:{states:['ACCEPTED']}})}else validity.visibility={states:['ACCEPTED']};
   assert.throws(()=>validateDesign(d,{mode:'publish'}),e=>e.status===422);
 }
})
test("contrast follows the effective background and text inherited through containers", () => {
  const d = design(),
    parent = node("parent", "Section", [
      {
        ...node("child"),
        styles: { desktop: { color: "#ffffff" }, tablet: {}, mobile: {} },
      },
    ]);
  d.nodes.push(parent);
  parent.styles.desktop = { background: "#ffffff" };
  assert.throws(
    () => load().validateDesign(d),
    (e) => e.status === 422,
  );
  parent.styles.desktop = { background: "#111111", color: "#ffffff" };
  assert.doesNotThrow(() => load().validateDesign(d));
});
test("valid designs have stable canonical hashes but a changed visual property changes the hash", () => {
  const { validateDesign } = load(),
    a = design(),
    b = { ...a, theme: { color: "#112233", background: "#ffffff" } };
  assert.match(validateDesign(a).designHash, /^[0-9a-f]{64}$/);
  assert.notEqual(validateDesign(a).designHash, validateDesign(b).designHash);
  assert.equal(
    validateDesign(a).designHash,
    validateDesign(JSON.parse(JSON.stringify(a))).designHash,
  );
});
test("publication requires unique visible official facts, including ancestor visibility", () => {
  const { validateDesign } = load();
  for (const mutate of [
    (d) => d.nodes.pop(),
    (d) => d.nodes.push(node("second", "Summary")),
    (d) => (d.nodes[0].visibility = { states: ["ACCEPTED"] }),
    (d) => {
      d.nodes = [node("wrapper", "Section", d.nodes)];
      d.nodes[0].visibility = { states: ["ACCEPTED"] };
    },
  ]) {
    const d = design();
    mutate(d);
    assert.throws(
      () => validateDesign(d, { mode: "publish" }),
      (e) => e.status === 422,
    );
  }
  assert.doesNotThrow(() => validateDesign(design(), { mode: "publish" }));
});
test("unknown fields, prototype keys, CSS URLs and unsafe links never enter a trusted design", () => {
  const { validateDesign } = load();
  for (const mutate of [
    (d) => (d.companyId = "OTHER"),
    (d) => (d.nodes[0].props.total = "0.01"),
    (d) => d.nodes.push(node("bad", "Script")),
    (d) => (d.theme.background = "url(https://evil.test)"),
    (d) => (d.nodes[0].styles.desktop.position = "absolute"),
    (d) =>
      d.nodes.push({ ...node("link"), props: { href: "javascript:alert(1)" } }),
  ]) {
    const d = design();
    mutate(d);
    assert.throws(
      () => validateDesign(d),
      (e) => e.status === 422,
    );
  }
  const d = design();
  d.theme = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(
    () => validateDesign(d),
    (e) => e.status === 422,
  );
});
test("node, depth, columns and UTF-8 code limits are enforced before saving", () => {
  const { validateDesign } = load(),
    many = design();
  many.nodes = Array.from({ length: 201 }, (_, i) => node("n" + i));
  assert.throws(
    () => validateDesign(many),
    (e) => e.status === 422,
  );
  const deep = design();
  let p = deep.nodes[0];
  for (let i = 0; i < 7; i++) {
    const child = node("d" + i);
    p.children = [child];
    p = child;
  }
  assert.throws(
    () => validateDesign(deep),
    (e) => e.status === 422,
  );
  const columns = design();
  columns.nodes.push({ ...node("c", "Columns"), props: { columns: 4 } });
  assert.throws(
    () => validateDesign(columns),
    (e) => e.status === 422,
  );
  const code = design();
  code.customBlocks.visual = {
    html: "",
    css: "",
    js: "x".repeat(128 * 1024 + 1),
    fallbackText: "",
  };
  assert.throws(
    () => validateDesign(code),
    (e) => e.status === 413,
  );
  const huge = design();
  huge.nodes.push({ ...node("text"), props: { text: "ñ".repeat(300 * 1024) } });
  assert.throws(
    () => validateDesign(huge),
    (e) => e.status === 413,
  );
});
test("unavailable or foreign resources and unresolved references block publication, not editing", () => {
  const { validateDesign } = load(),
    d = design();
  d.nodes.push({ ...node("photo", "Image"), props: { resource: "photo" } });
  d.resources.photo = { assetId: "known-other-tenant", alt: "Foto" };
  assert.doesNotThrow(() => validateDesign(d));
  assert.throws(
    () => validateDesign(d, { mode: "publish", assets: [] }),
    (e) => e.status === 422,
  );
  assert.doesNotThrow(() =>
    validateDesign(d, {
      mode: "publish",
      assets: [{ id: "known-other-tenant" }],
    }),
  );
});
test("low contrast and injected rich text are rejected; code stays inert and gets its own hash", () => {
  const { validateDesign } = load(),
    d = design();
  d.theme = { color: "#ffffff", background: "#ffffff" };
  assert.throws(
    () => validateDesign(d),
    (e) => e.status === 422,
  );
  const code = design();
  code.customBlocks.visual = {
    html: "<script>global.evaluated=1</script>",
    css: "",
    js: "global.evaluated=1",
    fallbackText: "Decoración",
  };
  assert.match(validateDesign(code).codeHash, /^[0-9a-f]{64}$/);
  assert.equal(global.evaluated, undefined);
  const rich = design();
  rich.nodes.push({
    ...node("rich", "Text"),
    props: { document: [{ type: "script", text: "alert(1)" }] },
  });
  assert.throws(
    () => validateDesign(rich),
    (e) => e.status === 422,
  );
});
