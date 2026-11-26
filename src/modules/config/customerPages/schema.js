const limits = Object.freeze({
  nodes: 200,
  depth: 6,
  columns: 3,
  customBlocks: 10,
  images: 20,
  designBytes: 512 * 1024,
  blockCodeBytes: 128 * 1024,
  codeBytes: 256 * 1024,
  richTextBytes: 200 * 1024,
  history: 100,
});
const definitions = {
  Section: { label: "Sección", container: true, props: { label: "string" } },
  Columns: {
    label: "Columnas",
    container: true,
    props: { label: "string", columns: "columns" },
  },
  Heading: { label: "Título", props: { text: "string", level: "heading" } },
  Text: { label: "Texto", props: { text: "string", document: "richText" } },
  Image: {
    label: "Imagen",
    props: {
      resource: "key",
      caption: "string",
      focalX: "percent",
      focalY: "percent",
    },
  },
  Gallery: { label: "Galería", props: { resources: "keys", title: "string" } },
  Divider: { label: "Separador", props: {} },
  Spacer: { label: "Espacio", props: { height: "space" } },
  Benefits: { label: "Beneficios", props: { title: "string", items: "texts" } },
  FAQ: {
    label: "Preguntas frecuentes",
    props: { title: "string", items: "faq" },
  },
  Contact: {
    label: "Contacto",
    props: {
      title: "string",
      email: "string",
      phone: "string",
      address: "string",
    },
  },
  Link: { label: "Enlace", props: { label: "string", href: "url" } },
  Identity: {
    label: "Identidad del documento",
    official: true,
    required: true,
    props: { title: "string" },
  },
  Customer: { label: "Cliente", official: true, props: { title: "string" } },
  Validity: { label: "Vigencia", official: true, requiredFor: ["QUOTE"], props: { title: "string" } },
  Items: {
    label: "Productos y servicios",
    official: true,
    required: true,
    props: {
      title: "string",
      layout: "layout",
      showImages: "boolean",
      showCodes: "boolean",
      density: "density",
    },
  },
  Summary: {
    label: "Resumen e importe",
    official: true,
    required: true,
    props: { title: "string" },
  },
  Terms: {
    label: "Condiciones del documento",
    official: true,
    props: { title: "string" },
  },
  QuoteResponse: {
    label: "Respuesta de cotización",
    official: true,
    required: true,
    documentType: "QUOTE",
    props: { title: "string", description: "string" },
  },
  Download: {
    label: "Descargar PDF",
    official: true,
    documentType: "QUOTE",
    props: { label: "string" },
  },
  OrderProgress: {
    label: "Cumplimiento del pedido",
    official: true,
    required: true,
    documentType: "ORDER",
    props: { title: "string", showQuantities: "boolean" },
  },
  OrderSales: {
    label: "Ventas vinculadas",
    official: true,
    documentType: "ORDER",
    props: { title: "string" },
  },
  CustomVisual: { label: "Código visual aislado", props: { blockId: "key" } },
};
const schemaManifest = Object.freeze({
  schemaVersion: 1,
  limits,
  documentTypes: ["QUOTE", "ORDER"],
  breakpoints: ["desktop", "tablet", "mobile"],
  blocks: definitions,
  fonts: ["system", "serif", "mono"],
});
const isRequired = (def, documentType) => def.required || def.requiredFor?.includes(documentType);
module.exports = { limits, definitions, schemaManifest, isRequired };
