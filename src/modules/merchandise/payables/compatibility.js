const crypto = require("node:crypto");
const { assertAccess, entryWhere } = require("./access"),
  {
    postSupplierPayment,
    lockSupplier,
    loadEntries,
    syncEntry,
    details,
    TX,
  } = require("./payments"),
  { balanceOf } = require("./balance"),
  { fail } = require("./money");
function shapePaymentBalance(row) {
  const b = balanceOf(row);
  return {
    payment_status: b.status === "REVIEW" ? row.payment_status : b.status,
    totalValue: Number(b.total),
    amount_paid_total: Number(b.documentedPaid),
    legacy_settled_amount: Number(b.legacySettled),
    amount_pending: b.balance === null ? null : Number(b.balance),
    payment_balance_review_required: b.status === "REVIEW",
    payment_revision: b.revision,
  };
}
async function entry(db, scope, id) {
  const r = await db.incomingMerchandise.findFirst({
    where: { ...entryWhere(scope), id },
    include: details,
  });
  if (!r) fail("Registro de mercancía no encontrado", 404, "NOT_FOUND");
  return r;
}
async function individual(tx, scope, row, body, key) {
  const settings = await tx.systemSetting.findMany({
    where: { company_id: scope.companyId, key: "currency_code" },
    select: { key: true, value: true },
  });
  const when = body.paid_at ? new Date(body.paid_at) : new Date();
  if (Number.isNaN(when.getTime())) fail("Fecha de pago inválida");
  return postSupplierPayment(
    tx,
    scope,
    {
      requestKey: key || crypto.randomUUID(),
      supplierId: row.supplier_id,
      amount: body.amount,
      currencyCode:
        settings.find((s) => s.key === "currency_code")?.value || "GTQ",
      paidAt: when.toISOString(),
      paymentMethodId: body.payment_method_id ?? null,
      reference: body.reference ?? null,
      notes: null,
      applications: [
        {
          incomingId: row.id,
          amount: body.amount,
          expectedRevision: body.expected_revision ?? row.payment_revision,
        },
      ],
    },
  );
}
const addIndividualPayment = (db, scope, id, body, key) =>
  db.$transaction(async (tx) => {
    await assertAccess(tx, scope, { write: true });
    return individual(tx, scope, await entry(tx, scope, id), body, key);
  }, TX);
async function changePaymentConditions(db, scope, id, body, key) {
  return db.$transaction(async (tx) => {
    await assertAccess(tx, scope, { write: true });
    const initial = await entry(tx, scope, id);
    await lockSupplier(tx, scope, initial.supplier_id);
    const [row] = await loadEntries(tx, scope, [id], initial.supplier_id),
      before = {
        ...balanceOf(row),
        conditions: {
          due_date: row.due_date ? new Date(row.due_date).toISOString() : null,
          payment_term_id: row.payment_term_id ?? null,
          payment_reference: row.payment_reference ?? null,
        },
      },
      data = {};
    if (row.source === "INITIAL")
      fail("La carga inicial no es una cuenta por pagar");
    if (
      body.payment_status !== undefined &&
      !["PAID", "PENDING", "PARTIAL"].includes(body.payment_status)
    )
      fail("Estado inválido");
    if (body.payment_status === "PARTIAL")
      fail(
        "Para registrar un pago parcial, indica el monto en Registrar abono",
      );
    if (
      body.payment_status === "PENDING" &&
      (Number(before.documentedPaid) > 0 || Number(before.legacySettled) > 0)
    )
      fail(
        "Anula el pago o corrige la liquidación histórica antes de volver a pendiente",
        409,
        "PAYMENTS_EXIST",
      );
    if (body.payment_term_id !== undefined) {
      const supplier = await tx.supplier.findFirst({
          where: { id: row.supplier_id, company_id: scope.companyId },
          include: { supplier_payment_terms: true },
        }),
        terms = supplier?.supplier_payment_terms || [],
        term =
          body.payment_term_id === null || body.payment_term_id === ""
            ? null
            : Number(body.payment_term_id);
      if (
        term === null
          ? terms.length > 0
          : !Number.isInteger(term) ||
            !terms.some((t) => t.payment_term_id === term)
      )
        fail("Selecciona un término asignado a este proveedor");
      data.payment_term_id = term;
    }
    if (body.payment_reference !== undefined) {
      if (
        typeof body.payment_reference !== "string" &&
        body.payment_reference !== null
      )
        fail("Referencia inválida");
      if (body.payment_reference?.length > 255)
        fail("La referencia admite 255 caracteres");
      data.payment_reference = body.payment_reference?.trim() || null;
    }
    if (body.due_date !== undefined) {
      const d = body.due_date ? new Date(body.due_date) : null;
      if (d && Number.isNaN(d.getTime())) fail("Vencimiento inválido");
      data.due_date = d;
    }
    if (body.payment_status === "PAID" && before.balance === null)
      fail("Revisa primero el saldo histórico", 409, "BALANCE_REVIEW");
    if (body.payment_status === "PAID" && Number(before.balance) > 0)
      await individual(
        tx,
        scope,
        row,
        { ...body, amount: before.balance, reference: body.payment_reference },
        key,
      );
    if (Object.keys(data).length) {
      await tx.incomingMerchandise.update({ where: { id }, data });
      await syncEntry(tx, scope, id, before, "CONDITIONS_UPDATED");
    }
    return entry(tx, scope, id);
  }, TX);
}
async function settleNewPurchase(tx, scope, row, body) {
  if (row.source !== "PURCHASE" || body.payment_status !== "PAID") return;
  const current = await entry(tx, scope, row.id),
    balance = balanceOf(current);
  if (Number(balance.balance) > 0)
    await individual(
      tx,
      scope,
      current,
      {
        amount: balance.balance,
        paid_at: body.paid_at,
        payment_method_id: body.payment_method_id,
        reference: body.payment_reference,
      },
      crypto.randomUUID(),
    );
  return entry(tx, scope, row.id);
}
module.exports = {
  shapePaymentBalance,
  addIndividualPayment,
  changePaymentConditions,
  settleNewPurchase,
};
