const { createHash } = require("node:crypto");
const fail = (status, path, message, code = "PORTAL_INVALID") =>
  Object.assign(Error(message), {
    status,
    code,
    diagnostics: [{ path, code, message, severity: "error" }],
  });
function plain(value, path) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw fail(422, path, "Se esperaba un objeto válido");
  for (const key of Object.keys(value))
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw fail(422, path, "Propiedad no permitida");
  return value;
}
function keys(value, allowed, path) {
  plain(value, path);
  for (const k of Object.keys(value))
    if (!allowed.includes(k))
      throw fail(422, path + "." + k, "Campo no admitido en este diseño");
}
const keyName = (v) =>
  typeof v === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(v);
function text(v, path, max = 10000) {
  if (
    typeof v !== "string" ||
    v.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)
  )
    throw fail(422, path, "Texto no válido o demasiado largo");
  return v;
}
function safeUrl(v, path) {
  text(v, path, 1000);
  try {
    const u = new URL(v);
    if (
      !["https:", "mailto:", "tel:"].includes(u.protocol) ||
      u.username ||
      u.password
    )
      throw Error();
    if (
      u.protocol === "https:" &&
      (!u.hostname || /^(localhost|127\.|0\.|\[::)/i.test(u.hostname))
    )
      throw Error();
    return v;
  } catch {
    throw fail(422, path, "Usa un enlace https, correo o teléfono válido");
  }
}
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v;
}
const hash = (v) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
module.exports = { fail, plain, keys, keyName, text, safeUrl, hash };
