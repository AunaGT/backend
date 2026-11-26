const { Router, json } = require("express");
function createBodyBoundary() {
  const router = Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      !req.is("application/json") &&
      !(req.path === "/assets" && req.is("multipart/form-data"))
    )
      return res
        .status(415)
        .json({ message: "Envía JSON o una imagen en la biblioteca" });
    next();
  });
  router.use(json({ limit: "640kb", inflate: false }));
  router.use((error, _req, res, _next) =>
    res
      .status(error.type === "entity.too.large" ? 413 : 400)
      .json({
        message:
          error.type === "entity.too.large"
            ? "La solicitud supera 640 KiB"
            : "El contenido no es JSON válido sin compresión",
      }),
  );
  return router;
}
module.exports = { createBodyBoundary };
