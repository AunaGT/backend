const { Router } = require("express");
function createRouter(options = {}) {
  const router = Router();
  router.get(
    "/:documentType/:token/versions/:versionId/assets/:assetKey",
    async (req, res, next) => {
      try {
        res.set({
          "Cache-Control": "private, no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        });
        const file =
          await require("../../../services/customerPagesPublic").readPublicPortalAsset(
            options.db || require("../../../models/prisma").prisma,
            {
              documentType: req.params.documentType,
              publicToken: req.params.token,
              versionId: req.params.versionId,
              assetKey: req.params.assetKey,
            },
          );
        res.type(file.mime).send(file.buffer);
      } catch (error) {
        if (error.status)
          return res.status(error.status).json({ message: error.message });
        next(error);
      }
    },
  );
  return router;
}
module.exports = { createRouter };
