const { keys, text, safeUrl, fail } = require("./validationHelpers");
const nodes = new Set([
  "doc",
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "text",
  "hardBreak",
]);
function validateRichText(document, path) {
  let count = 0;
  function visit(node, depth) {
    if (++count > 3000 || depth > 12)
      throw fail(422, path, "El texto enriquecido es demasiado complejo");
    keys(node, ["type", "content", "text", "marks", "attrs"], path);
    if (!nodes.has(node.type))
      throw fail(422, path, "Formato de texto no permitido");
    if (node.text !== undefined) text(node.text, path, 20000);
    if (node.attrs) {
      keys(node.attrs, ["level", "start", "textAlign"], path);
      if (
        node.attrs.level !== undefined &&
        ![2, 3, 4].includes(node.attrs.level)
      )
        throw fail(422, path, "Nivel de título no permitido");
      if (
        node.attrs.start !== undefined &&
        (!Number.isSafeInteger(node.attrs.start) ||
          node.attrs.start < 1 ||
          node.attrs.start > 1000)
      )
        throw fail(422, path, "Inicio de lista inválido");
      if (
        node.attrs.textAlign !== undefined &&
        !["left", "center", "right"].includes(node.attrs.textAlign)
      )
        throw fail(422, path, "Alineación inválida");
    }
    if (node.marks) {
      if (!Array.isArray(node.marks) || node.marks.length > 5)
        throw fail(422, path, "Formato de texto no válido");
      for (const mark of node.marks) {
        keys(mark, ["type", "attrs"], path);
        if (
          !["bold", "italic", "underline", "strike", "link"].includes(mark.type)
        )
          throw fail(422, path, "Marca no permitida");
        if (mark.attrs) {
          keys(mark.attrs, ["href", "target", "rel"], path);
          if (mark.type !== "link")
            throw fail(422, path, "Atributos de marca no permitidos");
          safeUrl(mark.attrs.href, path);
        }
      }
    }
    if (node.content) {
      if (!Array.isArray(node.content))
        throw fail(422, path, "Contenido no válido");
      node.content.forEach((n) => visit(n, depth + 1));
    }
  }
  if (Array.isArray(document)) document.forEach((n) => visit(n, 0));
  else visit(document, 0);
  return document;
}
module.exports = { validateRichText };
