const express = require("express"),
  path = require("node:path");
const {
  readArtifact,
} = require("../modules/config/customerPages/isolation/artifactStore");
const { contentPolicy, trustedOrigins } = require("./headers");
function createSandboxApp({ artifactRoot, allowedEmbedOrigins }) {
  if (!path.isAbsolute(artifactRoot))
    throw Error("Artifact root must be absolute");
  const parents = trustedOrigins(allowedEmbedOrigins),
    app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
    });
    next();
  });
  app.get("/artifacts/:hash", async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.hash)) return res.status(404).end();
    try {
      const artifact = await readArtifact(artifactRoot, req.params.hash);
      res
        .set("Content-Security-Policy", contentPolicy(artifact.policy, parents))
        .type("html")
        .send(artifact.html);
    } catch {
      res.status(404).end();
    }
  });
  app.use((_req, res) => res.status(404).end());
  return app;
}
module.exports = { createSandboxApp };
