const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
test("readiness fails closed for missing attestation, storage and same-origin or non-HTTPS URLs", () => {
  const {
    readSandboxCapabilities,
  } = require("../src/modules/config/customerPages/isolation/capabilities");
  const good = {
    enabled: "true",
    origin: "https://isolated.example.net",
    appOrigins: ["https://erp.example.com"],
    verifiedPolicyVersion: "1",
    storeReady: true,
  };
  assert.equal(readSandboxCapabilities(good).ready, true);
  for (const edit of [
    { enabled: "false" },
    { verifiedPolicyVersion: "0" },
    { storeReady: false },
    { origin: "https://erp.example.com" },
    { origin: "http://isolated.example.net" },
    { origin: "https://user:password@isolated.example.net" },
    { origin: "https://isolated.example.net/path" },
    { origin: "" },
  ])
    assert.equal(readSandboxCapabilities({ ...good, ...edit }).ready, false);
});
test("the standalone artifact server has restrictive HTTP headers and cannot traverse or serve arbitrary files", async (t) => {
  const {
      compileCustomBlock,
    } = require("../src/modules/config/customerPages/isolation/compile"),
    {
      writeArtifact,
    } = require("../src/modules/config/customerPages/isolation/artifactStore"),
    { createSandboxApp } = require("../src/customerPagesSandbox/app");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "portal-sandbox-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifact = compileCustomBlock(
    { html: "<p>Ejemplo</p>", css: "", js: "", fallbackText: "Ejemplo" },
    { channelId: "channel-123" },
  );
  await writeArtifact(root, artifact);
  const s = createSandboxApp({
    artifactRoot: root,
    allowedEmbedOrigins: ["https://erp.example.com"],
  }).listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  t.after(() => new Promise((r) => s.close(r)));
  const base = `http://127.0.0.1:${s.address().port}`;
  const response = await fetch(base + "/artifacts/" + artifact.sha256, {
    headers: { Cookie: "secret-session=x" },
  });
  assert.equal(response.status, 200);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-ancestors https:\/\/erp.example.com/);
  assert.match(csp, /sandbox allow-scripts/);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("x-frame-options"), null);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  for (const url of [
    "/artifacts/../../secret",
    "/artifacts/" + artifact.sha256 + ".html",
    "/health",
    "/.env",
  ])
    assert.equal((await fetch(base + url)).status, 404);
});
