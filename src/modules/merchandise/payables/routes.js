const router = require("express").Router(),
  { Auth, hasPermission } = require("../../../middlewares/autenticacion"),
  c = require("./controller");
const view = hasPermission("merchandise.details"),
  write = hasPermission("merchandise.mark_paid");
router.use(Auth);
router.post("/selection", view, c.selection);
router.get("/summary", view, c.summary);
router.get("/entries", view, c.entries);
router.get("/suppliers", view, c.suppliers);
router.get("/aging", view, c.aging);
router.get("/suppliers/:id", view, c.statement);
router.get("/payments/:id", view, c.receipt);
router.post("/payments", write, c.create);
router.post("/payments/:id/cancel", write, c.cancel);
router.post("/entries/:id/correct", write, c.correct);
router.get("/export", view, hasPermission("merchandise.reports"), c.export);
module.exports = router;
