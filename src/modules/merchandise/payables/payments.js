const crypto = require("node:crypto"),
  { Prisma } = require("@prisma/client"),
  { assertAccess, entryWhere } = require("./access"),
  { parseSupplierPayment } = require("./validation"),
  { balanceOf, planApplications } = require("./balance"),
  { fail } = require("./money");
const TX = { timeout: 30000, maxWait: 5000 },
  details = { items: true, paymentEntries: true };
const receiptInclude = {
  company: { select: { id: true, name: true } },
  branch: { select: { id: true, name: true } },
  supplier: { select: { id: true, name: true } },
  registeredBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  paymentMethod: { select: { id: true, name: true } },
  applications: {
    include: { incomingMerchandise: { select: { id: true } } },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
  },
};
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const iso = (v) => (v ? new Date(v).toISOString() : null);
function receiptDto(r) {
  return {
    id: r.id,
    status: r.status,
    companyId: r.company_id,
    companyName: r.company.name,
    branchId: r.branch_id,
    branchName: r.branch.name,
    supplierId: r.supplier_id,
    supplierName: r.supplier.name,
    amount: r.amount.toString(),
    currencyCode: r.currency_code,
    paidAt: iso(r.paid_at),
    paymentMethod: r.paymentMethod,
    reference: r.reference,
    notes: r.notes,
    registeredBy: r.registeredBy,
    createdAt: iso(r.created_at),
    cancelledAt: iso(r.cancelled_at),
    cancelledBy: r.cancelledBy || null,
    cancelReason: r.cancel_reason || null,
    applications: r.applications.map((a) => ({
      incomingId: a.incoming_merchandise_id,
      reference: a.incoming_merchandise_id.slice(0, 8).toUpperCase(),
      amount: a.amount.toString(),
      cancelledAt: iso(a.cancelled_at),
    })),
  };
}
async function loadReceipt(db, scope, id) {
  const row = await db.supplierPayment.findFirst({
    where: {
      id,
      company_id: scope.companyId,
      branch_id: scope.branchId || { in: scope.branchIds },
    },
    include: receiptInclude,
  });
  if (!row) fail("Pago no disponible", 404, "NOT_FOUND");
  return row;
}
async function lockSupplier(tx, scope, supplierId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payables:${scope.companyId}:${supplierId}`},0))`;
}
async function loadEntries(tx, scope, ids, supplierId) {
  await tx.$queryRaw(
    Prisma.sql`SELECT m.id FROM incoming_merchandise m JOIN branches b ON b.id=m.branch_id WHERE m.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) AND m.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid ORDER BY m.id FOR UPDATE OF m`,
  );
  const rows = await tx.incomingMerchandise.findMany({
    where: {
      ...entryWhere(scope),
      id: { in: ids },
      ...(supplierId ? { supplier_id: supplierId } : {}),
    },
    include: details,
  });
  if (rows.length !== ids.length)
    fail(
      "Una entrada no está disponible en este alcance",
      404,
      "ENTRY_UNAVAILABLE",
    );
  return rows;
}
async function syncEntry(tx, scope, id, before, action, reason = null) {
  const row = await tx.incomingMerchandise.findFirst({
    where: { ...entryWhere(scope), id },
    include: details,
  });
  if (!row) fail("Entrada no disponible", 404, "NOT_FOUND");
  const after = balanceOf(row),
    active = row.paymentEntries.filter((e) => !e.cancelled_at),
    latest = active.map((p) => new Date(p.paid_at)).sort((a, b) => b - a)[0];
  await tx.incomingMerchandise.update({
    where: { id },
    data: {
      ...(after.status !== "REVIEW" ? { payment_status: after.status } : {}),
      paid_at:
        after.status === "PAID" ? latest || row.paid_at || new Date() : null,
      payment_updated_by: scope.userId,
      payment_updated_at: new Date(),
      payment_revision: { increment: 1 },
    },
  });
  after.revision++;
  await tx.merchandisePaymentAuditEvent.create({
    data: {
      id: crypto.randomUUID(),
      company_id: scope.companyId,
      incoming_merchandise_id: id,
      actor_id: scope.userId,
      action,
      reason,
      before,
      after,
    },
  });
  return after;
}
async function postSupplierPayment(tx, scope, raw, options = {}) {
  const input = parseSupplierPayment(raw, options);
  await assertAccess(tx, scope, { write: true });
  if (
    !(await tx.supplier.findFirst({
      where: { id: input.supplierId, company_id: scope.companyId },
    }))
  )
    fail("Proveedor no disponible", 404, "NOT_FOUND");
  await lockSupplier(tx, scope, input.supplierId);
  const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify(canonical(input)))
      .digest("hex"),
    existing = await tx.supplierPayment.findUnique({
      where: {
        company_id_registered_by_request_key: {
          company_id: scope.companyId,
          registered_by: scope.userId,
          request_key: input.requestKey,
        },
      },
      include: receiptInclude,
    });
  if (existing) {
    if (existing.branch_id !== scope.branchId || existing.request_hash !== hash)
      fail(
        "La petición ya se utilizó con otra selección",
        409,
        "REQUEST_CONFLICT",
      );
    return receiptDto(existing);
  }
  const rows = await loadEntries(
    tx,
    scope,
    input.applications.map((a) => a.incomingId),
    input.supplierId,
  );
  const settings = await tx.systemSetting.findMany({
      where: { company_id: scope.companyId, key: "currency_code" },
      select: { key: true, value: true },
    }),
    currency = settings.find((s) => s.key === "currency_code")?.value || "GTQ";
  if (input.currencyCode !== currency)
    fail("La moneda no corresponde a la empresa");
  if (input.paymentMethodId !== null) {
    const method = await tx.paymentMethod.findUnique({
      where: { id: input.paymentMethodId },
    });
    if (!method || method.is_credit)
      fail("Selecciona un medio efectivo de pago, no crédito");
  }
  const balances = rows.map((row) => ({ id: row.id, ...balanceOf(row) })),
    applications = planApplications(balances, input),
    id = crypto.randomUUID();
  await tx.supplierPayment.create({
    data: {
      id,
      company_id: scope.companyId,
      branch_id: scope.branchId,
      supplier_id: input.supplierId,
      amount: input.amount,
      currency_code: input.currencyCode,
      paid_at: new Date(input.paidAt),
      payment_method_id: input.paymentMethodId,
      reference: input.reference,
      notes: input.notes,
      registered_by: scope.userId,
      request_key: input.requestKey,
      request_hash: hash,
    },
  });
  await tx.incomingMerchandisePaymentEntry.createMany({
    data: applications.map((a) => ({
      id: crypto.randomUUID(),
      incoming_merchandise_id: a.incomingId,
      supplier_payment_id: id,
      amount: a.amount,
      paid_at: new Date(input.paidAt),
      reference: input.reference,
      registered_by: scope.userId,
    })),
  });
  for (const row of rows)
    await syncEntry(tx, scope, row.id, balanceOf(row), "PAYMENT_POSTED");
  return receiptDto(await loadReceipt(tx, scope, id));
}
const createSupplierPayment = (db, scope, input, options) =>
  db.$transaction((tx) => postSupplierPayment(tx, scope, input, options), TX);
module.exports = {
  createSupplierPayment,
  postSupplierPayment,
  loadReceipt,
  receiptDto,
  receiptInclude,
  lockSupplier,
  loadEntries,
  syncEntry,
  details,
  TX,
};
