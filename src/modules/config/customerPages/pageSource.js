const { randomUUID } = require("node:crypto");
const cssTree = require("css-tree");
const { definitions, limits } = require("./schema");
const { validateDesign } = require("./validate");
const { fail } = require("./validationHelpers");
const tags = Object.fromEntries(
  Object.keys(definitions).map((type) => [
    "auna-" +
      type.replace(/[A-Z]/g, (c, i) => (i ? "-" : "") + c.toLowerCase()),
    type,
  ]),
);
const styles = {
  padding: "padding",
  margin: "margin",
  gap: "gap",
  "border-radius": "radius",
  "font-size": "fontSize",
  "line-height": "lineHeight",
  "max-width": "maxWidth",
  "-auna-columns": "columns",
  "-auna-image-height": "imageHeight",
  "background-color": "background",
  color: "color",
  "-auna-accent": "accent",
  "text-align": "align",
  "font-family": "fontFamily",
  "-auna-content-width": "contentWidth",
  "-auna-border": "border",
  "-auna-shadow": "shadow",
  "object-fit": "imageFit",
  "object-position": "imagePosition",
};
const numeric = new Set([
  "padding",
  "margin",
  "gap",
  "radius",
  "fontSize",
  "lineHeight",
  "maxWidth",
  "columns",
  "imageHeight",
]);
function sourceError(path, message, location, status = 422) {
  const error = fail(status, path, message);
  Object.assign(error.diagnostics[0], {
    line: location?.startLine || location?.line || 1,
    column: location?.startCol || location?.column || 1,
  });
  return error;
}
async function compilePageSource({ html, css, baseDesign }) {
  if (typeof html !== "string" || typeof css !== "string")
    throw sourceError("html", "Escribe HTML y CSS válidos");
  if (Buffer.byteLength(html + css) > limits.designBytes)
    throw sourceError("html", "El código de página supera 512 KiB", null, 413);
  validateDesign(baseDesign);
  const { parseFragment } = await import("parse5");
  const errors = [];
  const doc = parseFragment(html, {
    sourceCodeLocationInfo: true,
    onParseError: (e) => errors.push(e),
  });
  if (errors.length)
    throw sourceError("html", "HTML mal formado: " + errors[0].code, errors[0]);
  const elements = (children) =>
    (children || []).filter(
      (n) =>
        n.nodeName !== "#comment" &&
        !(n.nodeName === "#text" && !n.value.trim()),
    );
  const roots = elements(doc.childNodes);
  if (
    roots.length !== 1 ||
    roots[0].tagName !== "auna-page" ||
    roots[0].attrs.length
  )
    throw sourceError(
      "html",
      "Usa una raíz <auna-page> sin atributos",
      roots[0]?.sourceCodeLocation,
    );
  const next = structuredClone(baseDesign),
    ids = new Map();
  let count = 0;
  function visit(el, depth) {
    const loc = el.sourceCodeLocation;
    const error = (message) => sourceError("html", message, loc);
    if (++count > limits.nodes || depth > limits.depth)
      throw error("La página admite 200 bloques y 6 niveles");
    if (!el.tagName)
      throw error("Coloca el texto dentro de un componente o de <p>");
    let type = tags[el.tagName];
    const alias = {
      section: "Section",
      h2: "Heading",
      h3: "Heading",
      h4: "Heading",
      p: "Text",
      hr: "Divider",
      a: "Link",
      img: "Image",
    }[el.tagName];
    type ||= alias;
    if (!type)
      throw error(
        "Etiqueta no admitida: " +
          el.tagName +
          ". Usa componentes Auna o los alias de la ayuda.",
      );
    if (
      el.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
      (!alias && !loc?.endTag)
    )
      throw error("Cierra explícitamente el componente " + el.tagName);
    const attrs = Object.fromEntries(el.attrs.map((a) => [a.name, a.value]));
    const id = attrs.id || "n-" + randomUUID();
    if (ids.has(id)) throw error("Identificador repetido: " + id);
    const def = definitions[type],
      props = {},
      node = {
        id,
        type,
        props,
        styles: { desktop: {}, tablet: {}, mobile: {} },
        visibility: {},
        children: [],
      };
    ids.set(id, node);
    const names = Object.fromEntries(
      Object.keys(def.props).map((name) => [name.toLowerCase(), name]),
    );
    for (const [attr, value] of Object.entries(attrs)) {
      if (attr === "id") continue;
      if (
        alias &&
        ((type === "Image" && ["data-asset", "alt"].includes(attr)) ||
          (type === "Link" && attr === "href"))
      )
        continue;
      if (attr === "data-states") {
        try {
          node.visibility.states = JSON.parse(value);
        } catch {
          throw error("data-states debe ser una lista JSON");
        }
        continue;
      }
      const key = names[attr];
      if (!key) throw error("Atributo no admitido: " + attr);
      const kind = def.props[key];
      try {
        props[key] = ["string", "key", "url", "layout", "density"].includes(
          kind,
        )
          ? value
          : JSON.parse(value);
      } catch {
        throw error(
          "Valor inválido de " +
            attr +
            "; usa JSON para listas, números y booleanos",
        );
      }
    }
    const children = elements(el.childNodes);
    if (def.container)
      node.children = children.map((child) => visit(child, depth + 1));
    else if (alias && ["Heading", "Text", "Link"].includes(type)) {
      if (children.some((n) => n.nodeName !== "#text"))
        throw error(
          "Este alias admite texto, no etiquetas anidadas; usa auna-text con document para texto enriquecido",
        );
      const text = (el.childNodes || [])
        .filter((n) => n.nodeName === "#text")
        .map((n) => n.value)
        .join("");
      if (type === "Heading")
        Object.assign(props, { text, level: Number(el.tagName.slice(1)) });
      else if (type === "Link")
        Object.assign(props, { label: text, href: attrs.href || "" });
      else props.text = text;
    } else if (children.length)
      throw error(
        "Este componente no admite etiquetas o texto dentro; usa sus atributos",
      );
    if (alias && type === "Image") {
      props.resource = attrs["data-asset"] || "";
      if (attrs.alt !== undefined && next.resources[props.resource])
        next.resources[props.resource].alt = attrs.alt;
    }
    return node;
  }
  next.nodes = elements(roots[0].childNodes).map((n) => visit(n, 1));
  next.theme = {};
  let sheet;
  try {
    sheet = cssTree.parse(css, {
      positions: true,
      onParseError: (e) => {
        throw e;
      },
    });
  } catch (e) {
    throw sourceError("css", "CSS mal formado: " + e.message, e);
  }
  const reject = (node, message) => {
    throw sourceError("css", message, node.loc?.start);
  };
  function rules(list, point = "desktop") {
    list.forEach((rule) => {
      if (rule.type === "Atrule") {
        const query = cssTree
          .generate(rule.prelude || { type: "Raw", value: "" })
          .replace(/\s/g, "")
          .toLowerCase();
        if (
          point !== "desktop" ||
          rule.name.toLowerCase() !== "media" ||
          !["(max-width:1023px)", "(max-width:639px)"].includes(query) ||
          !rule.block
        )
          reject(
            rule,
            "Solo se permiten @media (max-width: 1023px) y @media (max-width: 639px)",
          );
        rules(rule.block.children, query.includes("639") ? "mobile" : "tablet");
        return;
      }
      if (rule.type !== "Rule") reject(rule, "Regla CSS no admitida");
      const selector = cssTree.generate(rule.prelude);
      let target;
      if (selector === "auna-page" && point === "desktop") target = next.theme;
      else if (
        /^#[A-Za-z][A-Za-z0-9_-]*$/.test(selector) &&
        ids.has(selector.slice(1))
      )
        target = ids.get(selector.slice(1)).styles[point];
      else
        reject(rule, "Usa auna-page para el tema o #id de un bloque existente");
      rule.block.children.forEach((decl) => {
        if (
          decl.type !== "Declaration" ||
          decl.important ||
          !Object.hasOwn(styles, decl.property)
        )
          reject(
            decl,
            "Propiedad CSS no admitida; consulta la ayuda de estilos",
          );
        const key = styles[decl.property],
          value = cssTree.generate(decl.value);
        if (numeric.has(key)) {
          const pattern = ["lineHeight", "columns"].includes(key)
            ? /^(\d+(?:\.\d+)?)$/
            : /^(\d+(?:\.\d+)?)px$|^(0)$/;
          if (!pattern.test(value))
            reject(
              decl,
              "Usa px para tamaños, y números para interlineado/columnas",
            );
          target[key] = parseFloat(value);
        } else target[key] = value;
      });
    });
  }
  rules(sheet.children);
  try {
    return validateDesign(next, {
      mode: "compose",
      documentType: baseDesign.documentType,
    }).design;
  } catch (error) {
    for (const diagnostic of error.diagnostics || [])
      Object.assign(diagnostic, { line: 1, column: 1 });
    throw error;
  }
}
module.exports = { compilePageSource };
