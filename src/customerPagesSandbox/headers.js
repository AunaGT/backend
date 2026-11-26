function trustedOrigins(values) {
  if (!Array.isArray(values) || !values.length)
    throw Error("Configure trusted embed origins");
  return values.map((value) => {
    const u = new URL(value);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.origin !== value ||
      u.username ||
      u.password
    )
      throw Error("Invalid embed origin");
    return u.origin;
  });
}
function contentPolicy({ scriptHashes = [], styleHashes = [] }, parents = []) {
  const source = (values) =>
    values.length
      ? values
          .map((v) => {
            if (!/^[A-Za-z0-9+/]{43}=$/.test(v))
              throw Error("Invalid CSP digest");
            return `'sha256-${v}'`;
          })
          .join(" ")
      : "'none'";
  return `default-src 'none'; script-src ${source(scriptHashes)}; style-src ${source(styleHashes)}; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${parents.length ? trustedOrigins(parents).join(" ") : "'none'"}; sandbox allow-scripts`;
}
module.exports = { contentPolicy, trustedOrigins };
