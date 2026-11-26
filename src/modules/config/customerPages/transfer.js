const { authorize } = require("./permissions");
const { getDraft, command, createIn } = require("./service");
const { validateDesign } = require("./validate");
const { fail, keys, text } = require("./validationHelpers");
const FORMAT = "AUNA_CUSTOMER_PAGE";
async function exportDesign(db, scope, id) {
  const draft = await getDraft(db, scope, id),
    design = structuredClone(draft.design);
  for (const resource of Object.values(design.resources)) resource.assetId = "";
  return {
    filename: `pagina-${id}.auna.json`,
    json: JSON.stringify({ format: FORMAT, version: 1, design }, null, 2),
  };
}
async function importDesign(db, scope, input) {
  authorize(scope, "manage");
  keys(input, ["name", "documentType", "source", "requestId"], "input");
  text(input.source, "source", 640 * 1024);
  if (Buffer.byteLength(input.source) > 640 * 1024)
    throw fail(413, "source", "El archivo supera el tamaño permitido");
  let parsed;
  try {
    parsed = JSON.parse(input.source);
  } catch {
    throw fail(422, "source", "El archivo no es JSON válido");
  }
  keys(parsed, ["format", "version", "design"], "source");
  if (parsed.format !== FORMAT || parsed.version !== 1)
    throw fail(422, "source", "Selecciona una exportación de páginas de Auna");
  const { design } = validateDesign(parsed.design, {
    documentType: input.documentType,
  });
  if (Object.values(design.resources).some((r) => r.assetId))
    throw fail(
      422,
      "resources",
      "Las imágenes importadas deben volver a vincularse",
    );
  if (Object.keys(design.customBlocks).length) authorize(scope, "code");
  return command(db, scope, "IMPORT", input, (tx) =>
    createIn(tx, scope, { ...input, design }),
  );
}
module.exports = { exportDesign, importDesign };
