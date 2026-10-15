const { assertAccess, entryWhere } = require("./access"),
  {
    parseCancellation,
    parseHistoricalCorrection,
    uuid,
  } = require("./validation"),
  {
    loadReceipt,
    receiptDto,
    lockSupplier,
    loadEntries,
    syncEntry,
    details,
    TX,
  } = require("./payments"),
  { balanceOf } = require("./balance"),
  { toCents, fail } = require("./money");
async function cancelSupplierPayment(db, scope, id, raw) {
  uuid(id);
  const { reason } = parseCancellation(raw);
  return db.$transaction(async (tx) => {
    await assertAccess(tx, scope, { write: true });
    const initial = await loadReceipt(tx, scope, id);
    await lockSupplier(tx, scope, initial.supplier_id);
    const receipt = await loadReceipt(tx, scope, id);
    if (receipt.status === "CANCELLED") return receiptDto(receipt);
    const ids = receipt.applications.map((a) => a.incoming_merchandise_id),
      rows = await loadEntries(tx, scope, ids, receipt.supplier_id),
      now = new Date();
    await tx.incomingMerchandisePaymentEntry.updateMany({
      where: { supplier_payment_id: id, cancelled_at: null },
      data: {
        cancelled_at: now,
        cancelled_by: scope.userId,
        cancel_reason: reason,
      },
    });
    await tx.supplierPayment.update({
      where: { id },
      data: {
        status: "CANCELLED",
        cancelled_at: now,
        cancelled_by: scope.userId,
        cancel_reason: reason,
      },
    });
    for (const row of rows)
      await syncEntry(
        tx,
        scope,
        row.id,
        balanceOf(row),
        "PAYMENT_CANCELLED",
        reason,
      );
    return receiptDto(await loadReceipt(tx, scope, id));
  }, TX);
}
async function scopedEntry(tx, scope, id) {
  const row = await tx.incomingMerchandise.findFirst({
    where: { ...entryWhere(scope), id },
    include: details,
  });
  if (!row) fail("Entrada no disponible", 404, "NOT_FOUND");
  return row;
}
async function correctHistoricalSettlement(db, scope, id, raw) {
  uuid(id);
  const input = parseHistoricalCorrection(raw);
  return db.$transaction(async (tx) => {
    await assertAccess(tx, scope, { write: true });
    const initial = await scopedEntry(tx, scope, id);
    await lockSupplier(tx, scope, initial.supplier_id);
    const [row] = await loadEntries(tx, scope, [id], initial.supplier_id),
      before = balanceOf(row);
    if (before.revision !== input.expectedRevision)
      fail("El saldo cambió. Actualiza el registro", 409, "STALE_BALANCE");
    if (
      balanceOf({
        ...row,
        legacy_settled_amount: input.amount,
        payment_balance_review_required: false,
      }).status === "REVIEW"
    )
      fail(
        "Revisa las partidas o anula los abonos incorrectos; la marca histórica no corrige esos importes",
        409,
        "BALANCE_REVIEW",
      );
    if (
      toCents(input.amount) + toCents(before.documentedPaid) >
      toCents(before.total)
    )
      fail("La liquidación y los abonos exceden el total");
    await tx.incomingMerchandise.update({
      where: { id },
      data: {
        legacy_settled_amount: input.amount,
        payment_balance_review_required: false,
      },
    });
    return syncEntry(
      tx,
      scope,
      id,
      before,
      "HISTORICAL_CORRECTED",
      input.reason,
    );
  }, TX);
}
async function cancelLegacyEntry(db, scope, id, entryId, raw) {
  uuid(id);
  uuid(entryId);
  const { reason } = parseCancellation(raw);
  return db.$transaction(async (tx) => {
    await assertAccess(tx, scope, { write: true });
    const initial = await scopedEntry(tx, scope, id);
    await lockSupplier(tx, scope, initial.supplier_id);
    const [row] = await loadEntries(tx, scope, [id], initial.supplier_id),
      entry = await tx.incomingMerchandisePaymentEntry.findFirst({
        where: { id: entryId, incoming_merchandise_id: id },
      });
    if (!entry) fail("Abono no disponible", 404, "NOT_FOUND");
    if (entry.supplier_payment_id)
      fail(
        "Este abono pertenece a un comprobante. Anula el pago completo",
        409,
        "GROUPED_PAYMENT",
        { supplierPaymentId: entry.supplier_payment_id },
      );
    if (entry.cancelled_at) return balanceOf(row);
    await tx.incomingMerchandisePaymentEntry.updateMany({
      where: { id: entryId, cancelled_at: null },
      data: {
        cancelled_at: new Date(),
        cancelled_by: scope.userId,
        cancel_reason: reason,
      },
    });
    return syncEntry(
      tx,
      scope,
      id,
      balanceOf(row),
      "LEGACY_ENTRY_CANCELLED",
      reason,
    );
  }, TX);
}
module.exports = {
  cancelSupplierPayment,
  correctHistoricalSettlement,
  cancelLegacyEntry,
};
