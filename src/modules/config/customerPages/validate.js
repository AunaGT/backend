const { limits, definitions, isRequired } = require("./schema");
const {
  fail,
  plain,
  keys,
  keyName,
  text,
  safeUrl,
  hash,
} = require("./validationHelpers");
const { validateStyles, contrast } = require("./styles");
const { validateRichText } = require("./richText");
function validateDesign(
  input,
  { mode = "draft", documentType, assets = [] } = {},
) {
  let serialized;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw fail(422, "design", "El diseño no es JSON válido");
  }
  if (!serialized || Buffer.byteLength(serialized) > limits.designBytes)
    throw fail(413, "design", "El diseño supera 512 KiB");
  keys(
    input,
    [
      "schemaVersion",
      "documentType",
      "theme",
      "nodes",
      "resources",
      "savedSections",
      "customBlocks",
    ],
    "design",
  );
  if (
    input.schemaVersion !== 1 ||
    !["QUOTE", "ORDER"].includes(input.documentType) ||
    (documentType && documentType !== input.documentType)
  )
    throw fail(422, "documentType", "Tipo o versión de diseño no compatible");
  keys(input.theme, ["accent", "background", "color", "fontFamily", "contentWidth", "padding"], "theme");
  const { contentWidth, ...themeStyles } = input.theme;
  if (contentWidth !== undefined && !["contained", "full"].includes(contentWidth))
    throw fail(422, "theme.contentWidth", "Elige contenido centrado o de ancho completo");
  validateStyles(themeStyles, "theme");
  const theme = { color: "#1f2937", background: "#ffffff", ...input.theme };
  if (contrast(theme.color, theme.background) < 4.5)
    throw fail(422, "theme", "Aumenta el contraste entre texto y fondo");
  plain(input.resources, "resources");
  plain(input.customBlocks, "customBlocks");
  if (
    Object.keys(input.resources).length > limits.images ||
    Object.keys(input.customBlocks).length > limits.customBlocks
  )
    throw fail(422, "design", "Demasiadas imágenes o bloques de código");
  const assetIds = new Set(assets.map((a) => a.id)),
    resourceKeys = new Set(Object.keys(input.resources));
  for (const [key, r] of Object.entries(input.resources)) {
    if (!keyName(key))
      throw fail(422, "resources", "Nombre de recurso inválido");
    keys(r, ["assetId", "alt"], "resources." + key);
    text(r.assetId, "resources." + key, 100);
    text(r.alt, "resources." + key, 300);
    if (mode === "publish" && (!r.assetId || !assetIds.has(r.assetId)))
      throw fail(
        422,
        "resources." + key,
        "Selecciona una imagen disponible de esta empresa",
      );
  }
  let codeBytes = 0;
  for (const [key, b] of Object.entries(input.customBlocks)) {
    if (!keyName(key))
      throw fail(422, "customBlocks", "Nombre de bloque inválido");
    keys(b, ["html", "css", "js", "fallbackText"], "customBlocks." + key);
    for (const field of ["html", "css", "js", "fallbackText"])
      text(b[field], "customBlocks." + key + "." + field, 300000);
    const size = Buffer.byteLength(b.html + b.css + b.js);
    codeBytes += size;
    if (size > limits.blockCodeBytes || codeBytes > limits.codeBytes)
      throw fail(
        413,
        "customBlocks." + key,
        "El código supera el tamaño permitido",
      );
  }
  const ids = new Set(),
    counts = {},
    references = new Set();
  let count = 0,
    richBytes = 0;
  function property(value, type, path) {
    if (type === "richText") {
      richBytes += Buffer.byteLength(JSON.stringify(value));
      if (richBytes > limits.richTextBytes)
        throw fail(413, path, "El texto enriquecido supera 200 KiB");
      return validateRichText(value, path);
    }
    if (type === "string") return text(value, path);
    if (type === "key") {
      if (!keyName(value)) throw fail(422, path, "Referencia no válida");
      return value;
    }
    if (type === "url") return safeUrl(value, path);
    if (type === "boolean" && typeof value === "boolean") return value;
    const enums = {
      heading: [2, 3, 4],
      columns: [1, 2, 3],
      layout: ["table", "cards"],
      density: ["compact", "comfortable"],
    };
    if (enums[type]?.includes(value)) return value;
    if (
      ["percent", "space"].includes(type) &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= (type === "percent" ? 100 : 96)
    )
      return value;
    if (
      ["keys", "texts", "faq"].includes(type) &&
      Array.isArray(value) &&
      value.length <= 20
    ) {
      for (const row of value) {
        if (type === "keys") property(row, "key", path);
        else if (type === "texts") text(row, path, 2000);
        else {
          keys(row, ["question", "answer"], path);
          text(row.question, path, 500);
          text(row.answer, path, 5000);
        }
      }
      return value;
    }
    throw fail(422, path, "Valor no válido para esta propiedad");
  }
  function visit(
    node,
    depth,
    conditional = false,
    palettes = { desktop: theme, tablet: theme, mobile: theme },
  ) {
    if (++count > limits.nodes || depth > limits.depth)
      throw fail(422, "nodes", "El diseño supera 200 bloques o 6 niveles");
    keys(
      node,
      ["id", "type", "props", "styles", "visibility", "children"],
      "nodes",
    );
    if (!keyName(node.id) || ids.has(node.id))
      throw fail(422, "nodes.id", "Identificador repetido o inválido");
    ids.add(node.id);
    const def = definitions[node.type];
    if (!def || (def.documentType && def.documentType !== input.documentType))
      throw fail(422, node.id, "Bloque no compatible con este tipo de página");
    keys(node.props, Object.keys(def.props), node.id + ".props");
    for (const [key, value] of Object.entries(node.props))
      property(value, def.props[key], node.id + "." + key);
    keys(node.styles, ["desktop", "tablet", "mobile"], node.id + ".styles");
    for (const point of ["desktop", "tablet", "mobile"]) {
      plain(node.styles[point], node.id + ".styles." + point);
      validateStyles(node.styles[point], node.id + ".styles." + point);
    }
    keys(node.visibility, ["states"], node.id + ".visibility");
    const states = node.visibility.states;
    if (
      states !== undefined &&
      (!Array.isArray(states) ||
        !states.length ||
        states.some(
          (s) =>
            ![
              "SENT",
              "ACCEPTED",
              "REJECTED",
              "EXPIRED",
              "DRAFT",
              "CONFIRMED",
              "PARTIALLY_FULFILLED",
              "FULFILLED",
              "CANCELLED",
            ].includes(s),
        ))
    )
      throw fail(422, node.id, "Regla de visibilidad inválida");
    counts[node.type] = (counts[node.type] || 0) + 1;
    if (
      mode !== "draft" &&
      def.official &&
      (counts[node.type] > 1 || (isRequired(def, input.documentType) && (conditional || states)))
    )
      throw fail(
        422,
        node.id,
        "La información oficial debe ser única y permanecer visible",
      );
    const effective = {};
    for (const point of ["desktop", "tablet", "mobile"]) {
      effective[point] = {
        ...palettes[point],
        ...node.styles.desktop,
        ...(point !== "desktop" ? node.styles.tablet : {}),
        ...(point === "mobile" ? node.styles.mobile : {}),
      };
      if (contrast(effective[point].color, effective[point].background) < 4.5)
        throw fail(422, node.id, "Aumenta el contraste del bloque");
    }
    if (
      node.type === "CustomVisual" &&
      !Object.hasOwn(input.customBlocks, node.props.blockId)
    )
      throw fail(422, node.id, "El bloque de código no está definido");
    if (node.type === "Image") references.add(node.props.resource);
    if (node.type === "Gallery")
      for (const r of node.props.resources || []) references.add(r);
    if (
      !Array.isArray(node.children) ||
      (!def.container && node.children.length)
    )
      throw fail(422, node.id, "Este bloque no admite contenido anidado");
    node.children.forEach((child) =>
      visit(child, depth + 1, conditional || !!states, effective),
    );
  }
  if (!Array.isArray(input.nodes))
    throw fail(422, "nodes", "Agrega los bloques del diseño");
  input.nodes.forEach((n) => visit(n, 1));
  for (const r of references)
    if (!resourceKeys.has(r))
      throw fail(422, "resources", "Vincula las imágenes del diseño");
  if (!Array.isArray(input.savedSections) || input.savedSections.length > 100)
    throw fail(422, "savedSections", "Catálogo de secciones inválido");
  for (const section of input.savedSections) {
    keys(section, ["id", "name", "nodes"], "savedSections");
    if (!keyName(section.id))
      throw fail(422, "savedSections", "Identificador inválido");
    text(section.name, "savedSections", 150);
    if (!Array.isArray(section.nodes))
      throw fail(422, "savedSections", "Sección no válida");
    const d = { ...input, nodes: section.nodes, savedSections: [] };
    validateDesign(d, { mode: "draft", documentType: input.documentType });
  }
  if (mode !== "draft")
    for (const [type, def] of Object.entries(definitions))
      if (
        isRequired(def, input.documentType) &&
        (!def.documentType || def.documentType === input.documentType) &&
        counts[type] !== 1
      )
        throw fail(422, "nodes", "Falta el bloque obligatorio: " + def.label);
  const design = JSON.parse(serialized);
  return {
    design,
    designHash: hash(design),
    codeHash: hash(design.customBlocks),
    diagnostics: [],
  };
}
module.exports = { validateDesign };
