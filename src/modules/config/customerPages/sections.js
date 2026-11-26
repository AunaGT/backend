const { randomUUID } = require("node:crypto");
const { authorize } = require("./permissions");
const { validateDesign } = require("./validate");
const { fail, keys } = require("./validationHelpers");
const { nameOf } = require("./service");
const { referencedResources, remapImageReferences } = require("./resources");
function sectionDesign({
  documentType,
  nodes,
  resources = {},
  customBlocks = {},
}) {
  return {
    schemaVersion: 1,
    documentType,
    theme: {},
    nodes,
    resources,
    customBlocks,
    savedSections: [],
  };
}
async function saveSection(db, scope, input) {
  authorize(scope, "manage");
  keys(
    input,
    ["name", "documentType", "nodes", "resources", "customBlocks"],
    "section",
  );
  const { design } = validateDesign(sectionDesign(input));
  if (Object.keys(design.customBlocks).length) authorize(scope, "code");
  return db.$transaction(async (tx) => {
    if (tx.$executeRaw)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`portal:${scope.companyId}`},0))`;
    if (
      (await tx.portalSavedSection.count({
        where: { company_id: scope.companyId },
      })) >= 100
    )
      throw fail(409, "sections", "La biblioteca admite hasta 100 secciones");
    for (const resource of Object.values(design.resources))
      if (
        resource.assetId &&
        !(await tx.portalAsset.findFirst({
          where: { company_id: scope.companyId, id: resource.assetId },
        }))
      )
        throw fail(422, "resources", "Imagen no disponible en esta empresa");
    return tx.portalSavedSection.create({
      data: {
        id: randomUUID(),
        company_id: scope.companyId,
        name: nameOf(input.name),
        document_type: design.documentType,
        design: { ...design, ...referencedResources(design, design.nodes) },
        created_by: scope.actorId,
      },
    });
  });
}
async function listSections(db, scope) {
  authorize(scope);
  return db.portalSavedSection.findMany({
    where: { company_id: scope.companyId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 100,
  });
}
function insertSection(design, section) {
  if (design.documentType !== section.document_type)
    throw fail(422, "section", "La sección corresponde a otro tipo de página");
  const source = { ...section.design, ...referencedResources(section.design, section.design.nodes) },
    resourceNames = Object.fromEntries(
      Object.keys(source.resources).map((k) => [k, "r-" + randomUUID()]),
    ),
    blockNames = Object.fromEntries(
      Object.keys(source.customBlocks).map((k) => [k, "b-" + randomUUID()]),
    ),
    rename = (nodes) =>
      nodes.map((n) => ({
        ...structuredClone(n),
        id: "n-" + randomUUID(),
        props: {
          ...n.props,
          ...(n.type === "Image"
            ? { resource: resourceNames[n.props.resource] }
            : {}),
          ...(n.type === "Gallery"
            ? { resources: n.props.resources.map((r) => resourceNames[r]) }
            : {}),
          ...(n.type === "CustomVisual"
            ? { blockId: blockNames[n.props.blockId] }
            : {}),
        },
        children: rename(n.children),
      }));
  const out = structuredClone(design);
  for (const [key, value] of Object.entries(source.resources))
    out.resources[resourceNames[key]] = structuredClone(value);
  for (const [key, value] of Object.entries(source.customBlocks))
    out.customBlocks[blockNames[key]] = { ...structuredClone(value), html: remapImageReferences(value.html, resourceNames) };
  out.nodes.push(...rename(source.nodes));
  validateDesign(out);
  const counts = {},
    definitions = require("./schema").definitions,
    visit = (nodes) => {
      for (const n of nodes) {
        if (definitions[n.type].official && ++counts[n.type] > 1)
          throw fail(
            422,
            "section",
            "La sección duplicaría información oficial",
          );
        if (definitions[n.type].official && !counts[n.type]) counts[n.type] = 1;
        visit(n.children);
      }
    };
  visit(out.nodes);
  return out;
}
module.exports = { saveSection, listSections, insertSection };
