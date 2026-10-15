function fail(message, status = 400, code = "INVALID_PAYMENT", data) {
  throw Object.assign(new Error(message), {
    status,
    code,
    ...(data ? { data } : {}),
  });
}
function toCents(value) {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) fail("Importe decimal inválido");
  const [whole, fraction = ""] = text.split("."),
    cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) fail("Importe fuera del rango seguro");
  return cents;
}
function fromCents(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0)
    fail("Importe fuera del rango seguro");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
function checked(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    fail("El importe requiere revisión");
  return value;
}
module.exports = { toCents, fromCents, checked, fail };
