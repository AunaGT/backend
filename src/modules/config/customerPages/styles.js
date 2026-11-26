const { fail } = require("./validationHelpers");
const numeric = {
  padding: [0, 96],
  margin: [0, 96],
  gap: [0, 64],
  radius: [0, 48],
  fontSize: [12, 64],
  lineHeight: [1, 2.5],
  maxWidth: [280, 1600],
  columns: [1, 3],
  imageHeight: [80, 800],
};
const enums = {
  align: ["left", "center", "right"],
  fontFamily: ["system", "serif", "mono"],
  border: ["none", "thin"],
  shadow: ["none", "soft", "strong"],
  imageFit: ["cover", "contain"],
  imagePosition: ["center", "top", "bottom", "left", "right"],
};
const color = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
function validateStyles(input, path) {
  const out = {};
  for (const [key, v] of Object.entries(input)) {
    if (numeric[key]) {
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        v < numeric[key][0] ||
        v > numeric[key][1] ||
        (key === "columns" && !Number.isInteger(v))
      )
        throw fail(
          422,
          path + "." + key,
          "Valor de estilo fuera del rango permitido",
        );
    } else if (["background", "color", "accent"].includes(key)) {
      if (!color(v))
        throw fail(
          422,
          path + "." + key,
          "Usa un color hexadecimal de seis dígitos",
        );
    } else if (!enums[key]?.includes(v))
      throw fail(
        422,
        path + "." + key,
        "Propiedad o valor de estilo no permitido",
      );
    out[key] = v;
  }
  return out;
}
function contrast(a, b) {
  const lum = (c) => {
    const rgb = c
      .match(/[0-9a-f]{2}/gi)
      .map((x) => parseInt(x, 16) / 255)
      .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const x = lum(a),
    y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
module.exports = { validateStyles, contrast, color };
