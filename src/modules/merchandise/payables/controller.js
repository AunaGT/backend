const { prisma, prismaTransaction } = require("../../../models/prisma"),
  { payableScope } = require("./access"),
  q = require("./queries"),
  p = require("./payments"),
  c = require("./corrections");
function handler(fn, status = 200) {
  return async (req, res, next) => {
    try {
      const data = await fn(req, payableScope(req));
      res.status(status).json(data);
    } catch (e) {
      if (e.status)
        return res
          .status(e.status)
          .json({
            message: e.message,
            code: e.code,
            ...(e.data ? { data: e.data } : {}),
          });
      next(e);
    }
  };
}
module.exports = {
  selection: handler((r, s) => q.payableSelection(prisma, s, r.body)),
  summary: handler((r, s) => q.payablesSummary(prisma, s, r.query)),
  entries: handler((r, s) => q.listPayableEntries(prisma, s, r.query)),
  suppliers: handler((r, s) => q.listPayableSuppliers(prisma, s, r.query)),
  aging: handler((r, s) => q.payablesAging(prisma, s, r.query)),
  statement: handler((r, s) =>
    q.supplierStatement(prisma, s, r.params.id, r.query),
  ),
  receipt: handler((r, s) => q.supplierPaymentReceipt(prisma, s, r.params.id)),
  export: handler((r, s) => q.exportPayables(prisma, s, r.query)),
  create: handler(
    (r, s) => p.createSupplierPayment(prismaTransaction, s, r.body),
    201,
  ),
  cancel: handler((r, s) =>
    c.cancelSupplierPayment(prismaTransaction, s, r.params.id, r.body),
  ),
  correct: handler((r, s) =>
    c.correctHistoricalSettlement(prismaTransaction, s, r.params.id, r.body),
  ),
};
