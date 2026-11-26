const fs = require("node:fs/promises"),
  path = require("node:path"),
  { createHash } = require("node:crypto");
function artifactPath(root, hash, extension) {
  if (!path.isAbsolute(root) || !/^[a-f0-9]{64}$/.test(hash))
    throw Error("Invalid artifact location");
  return path.join(root, hash + extension);
}
async function writeArtifact(root, artifact) {
  const html = artifactPath(root, artifact.sha256, ".html"),
    metadata = artifactPath(root, artifact.sha256, ".json");
  if (
    createHash("sha256").update(artifact.html).digest("hex") !== artifact.sha256
  )
    throw Error("Artifact integrity mismatch");
  // Immutable content-addressed files; a partial write never becomes a public default.
  for (const [file, value] of [
    [html, artifact.html],
    [metadata, JSON.stringify(artifact.policy)],
  ])
    try {
      await fs.writeFile(file, value, { flag: "wx", mode: 0o640 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if ((await fs.readFile(file, "utf8")) !== value)
        throw Error("Artifact integrity mismatch");
    }
  return artifact.sha256;
}
async function readArtifact(root, hash) {
  const [html, metadata] = await Promise.all([
    fs.readFile(artifactPath(root, hash, ".html"), "utf8"),
    fs.readFile(artifactPath(root, hash, ".json"), "utf8"),
  ]);
  if (
    Buffer.byteLength(html) > 12 * 1024 * 1024 ||
    createHash("sha256").update(html).digest("hex") !== hash
  )
    throw Error("Artifact integrity mismatch");
  return { html, policy: JSON.parse(metadata) };
}
module.exports = { writeArtifact, readArtifact, artifactPath };
