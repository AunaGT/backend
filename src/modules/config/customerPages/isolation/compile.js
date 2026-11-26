const parse5 = require("parse5"),
  cssTree = require("css-tree"),
  acorn = require("acorn"),
  { createHash } = require("node:crypto");
const { contentPolicy } = require("../../../../customerPagesSandbox/headers");
const { fail, text, keys } = require("../validationHelpers");
const digest = (value) => createHash("sha256").update(value).digest("base64");
const tags = new Set([
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "nav",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "small",
  "br",
  "hr",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "figure",
  "figcaption",
  "img",
  "button",
  "details",
  "summary",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "caption",
  "a",
]);
function diagnostic(field, message, line = 1, column = 1) {
  const error = fail(422, field, message);
  error.diagnostics = [
    {
      path: field,
      code: "PORTAL_CODE_INVALID",
      message,
      line,
      column,
      severity: "error",
    },
  ];
  return error;
}
function compileCustomBlock(block, { assetData = {}, channelId } = {}) {
  keys(block, ["html", "css", "js", "fallbackText"], "block");
  for (const field of ["html", "css", "js", "fallbackText"])
    text(block[field], field, 300000);
  if (Buffer.byteLength(block.html + block.css + block.js) > 128 * 1024)
    throw diagnostic("code", "El bloque supera 128 KiB");
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(channelId || ""))
    throw diagnostic("channel", "Canal visual no válido");
  let imageBytes = 0;
  const fragment = parse5.parseFragment(block.html, {
      sourceCodeLocationInfo: true,
    }),
    queue = [...fragment.childNodes];
  while (queue.length) {
    const n = queue.shift();
    if (n.nodeName === "#text" || n.nodeName === "#comment") continue;
    const loc = n.sourceCodeLocation;
    if (!tags.has(n.tagName))
      throw diagnostic(
        "html",
        "Etiqueta no admitida: " + n.tagName,
        loc?.startLine,
        loc?.startCol,
      );
    for (const a of n.attrs || []) {
      if (a.name === "data-asset" && n.tagName === "img") continue;
      if (
        a.name === "href" &&
        n.tagName === "a" &&
        /^#[A-Za-z][A-Za-z0-9_-]*$/.test(a.value)
      )
        continue;
      if (
        [
          "class",
          "id",
          "title",
          "role",
          "alt",
          "type",
          "open",
          "colspan",
          "rowspan",
          "aria-label",
          "aria-hidden",
          "aria-expanded",
          "aria-controls",
        ].includes(a.name) &&
        !a.namespace
      )
        continue;
      throw diagnostic(
        "html",
        "Atributo no admitido: " + a.name,
        loc?.startLine,
        loc?.startCol,
      );
    }
    if (n.tagName === "button")
      n.attrs = [
        ...n.attrs.filter((a) => a.name !== "type"),
        { name: "type", value: "button" },
      ];
    if (n.tagName === "img") {
      const key = n.attrs.find((a) => a.name === "data-asset")?.value,
        data = assetData[key];
      if (
        typeof data !== "string" ||
        !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(data)
      )
        throw diagnostic(
          "html",
          "Selecciona una imagen normalizada mediante data-asset",
          loc?.startLine,
          loc?.startCol,
        );
      imageBytes += data.length;
      if (imageBytes > 8 * 1024 * 1024)
        throw diagnostic("html", "Las imágenes del bloque superan 8 MiB");
      n.attrs = n.attrs.filter((a) => a.name !== "data-asset");
      n.attrs.push({ name: "src", value: data });
    }
    queue.push(...(n.childNodes || []));
  }
  let ast;
  try {
    ast = cssTree.parse(block.css, {
      positions: true,
      onParseError: (error) => {
        throw error;
      },
    });
  } catch (error) {
    throw diagnostic(
      "css",
      "CSS no válido: " + error.message,
      error.line,
      error.column,
    );
  }
  cssTree.walk(ast, (node) => {
    if (
      node.type === "Raw" ||
      node.type === "Url" ||
      (node.type === "Atrule" &&
        ["import", "font-face", "namespace"].includes(
          node.name.toLowerCase(),
        )) ||
      (node.type === "Function" &&
        ["url", "expression", "image-set", "-webkit-image-set"].includes(
          node.name.toLowerCase(),
        ))
    )
      throw diagnostic(
        "css",
        "No se permiten cargas externas ni expresiones activas",
        node.loc?.start.line,
        node.loc?.start.column,
      );
  });
  if (/<\/style/i.test(block.css))
    throw diagnostic("css", "La hoja no admite cierres de etiqueta style");
  let program;
  try {
    program = acorn.parse(block.js, {
      ecmaVersion: "latest",
      sourceType: "script",
      locations: true,
    });
  } catch (error) {
    throw diagnostic(
      "js",
      "JavaScript no válido: " + error.message,
      error.loc?.line,
      (error.loc?.column || 0) + 1,
    );
  }
  const pending = [program];
  while (pending.length) {
    const n = pending.pop();
    if (!n || typeof n !== "object") continue;
    if (
      n.type === "ImportExpression" ||
      n.type === "ImportDeclaration" ||
      n.type?.startsWith("Export")
    )
      throw diagnostic(
        "js",
        "No se permiten imports ni módulos externos",
        n.loc?.start.line,
        (n.loc?.start.column || 0) + 1,
      );
    for (const value of Object.values(n))
      if (value && typeof value === "object")
        Array.isArray(value) ? pending.push(...value) : pending.push(value);
  }
  const channel = JSON.stringify(channelId),
    runtime = `(()=>{const channelId=${channel};let last=0;const send=(kind,extra={})=>parent.postMessage({channelId,kind,...extra},'*');const resize=()=>{const now=Date.now();if(now-last<120)return;last=now;send('resize',{height:Math.min(800,Math.max(80,document.documentElement.scrollHeight))})};addEventListener('error',()=>send('error'));addEventListener('unhandledrejection',()=>send('error'));addEventListener('DOMContentLoaded',()=>{send('ready');resize();new ResizeObserver(resize).observe(document.body)})})();`;
  const js = block.js.replace(/<\/script/gi, "<\\/script"),
    css =
      "html{color-scheme:light}body{margin:0;overflow-wrap:anywhere;font:16px/1.5 system-ui,sans-serif}*{box-sizing:border-box}" +
      block.css;
  const policy = {
    scriptHashes: [digest(runtime), digest(js)],
    styleHashes: [digest(css)],
  };
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Contenido visual</title><style>' +
    css +
    "</style><script>" +
    runtime +
    "</script></head><body>" +
    parse5.serialize(fragment) +
    "<script>" +
    js +
    "</script></body></html>";
  return {
    html,
    sha256: createHash("sha256").update(html).digest("hex"),
    policy,
    csp: contentPolicy(policy),
    diagnostics: [],
    channelId,
  };
}
module.exports = { compileCustomBlock };
