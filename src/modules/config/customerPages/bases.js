const { fail } = require("./validationHelpers");
function resolveBase(documentType, baseId = "CLASSIC") {
  if (
    !["QUOTE", "ORDER"].includes(documentType) ||
    !["CLASSIC", "CATALOG", "SERVICES"].includes(baseId)
  )
    throw fail(422, "baseId", "Selecciona un tipo y una base disponibles");
  let index = 0;
  const node = (type, props = {}, children = [], style = {}) => ({
    id: `n-${++index}`,
    type,
    props,
    styles: { desktop: style, tablet: {}, mobile: {} },
    visibility: {},
    children,
  });
  const items = node("Items", {
    title: documentType === "QUOTE" ? "Tu propuesta" : "Tu pedido",
    layout: baseId === "CATALOG" ? "cards" : "table",
    showImages: baseId === "CATALOG",
    showCodes: baseId !== "SERVICES",
    density: baseId === "CLASSIC" ? "compact" : "comfortable",
  });
  const identity = node("Identity"),
    summary = node("Summary"),
    terms = node("Terms"),
    customer = node("Customer"),
    progress = node(
      documentType === "QUOTE" ? "QuoteResponse" : "OrderProgress",
    );
  const nodes =
    baseId === "CLASSIC"
      ? [
          identity,
          node("Columns", { columns: 2 }, [
            node("Section", {}, [items, terms]),
            node("Section", {}, [customer, node("Validity"), summary]),
          ]),
          progress,
        ]
      : baseId === "CATALOG"
        ? [
            node(
              "Section",
              {},
              [
                identity,
                node("Heading", {
                  text: "Una propuesta pensada para ti",
                  level: 2,
                }),
                node("Text", {
                  text: "Descubre los detalles y contáctanos si necesitas ayuda.",
                }),
              ],
              { padding: 32, background: "#f1f5f9" },
            ),
            customer,
            ...(documentType === "QUOTE" ? [node("Validity")] : []),
            items,
            summary,
            progress,
            terms,
          ]
        : [
            identity,
            node("Columns", { columns: 2 }, [
              node("Section", {}, [
                node("Heading", {
                  text: "Trabajemos en tu próximo proyecto",
                  level: 2,
                }),
                node("Text", {
                  text: "Una solución acompañada de atención personalizada.",
                }),
                node("Benefits", {
                  title: "Nuestro compromiso",
                  items: [
                    "Atención cercana",
                    "Condiciones claras",
                    "Acompañamiento durante el servicio",
                  ],
                }),
              ]),
              customer,
            ]),
            items,
            summary,
            terms,
            ...(documentType === "QUOTE" ? [node("Validity")] : []),
            progress,
            node("FAQ", {
              title: "¿Tienes alguna duda?",
              items: [
                {
                  question: "¿Cómo coordinamos el servicio?",
                  answer:
                    "Comunícate con nuestro equipo para confirmar los detalles y la disponibilidad.",
                },
              ],
            }),
          ];
  if (documentType === "QUOTE")
    nodes.push(node("Download", { label: "Descargar cotización" }));
  else nodes.push(node("OrderSales"));
  return {
    schemaVersion: 1,
    documentType,
    theme: {
      accent: "#e65a00",
      color: "#1f2937",
      background: "#ffffff",
      fontFamily: "system",
    },
    nodes,
    resources: {},
    savedSections: [],
    customBlocks: {},
  };
}
module.exports = { resolveBase };
