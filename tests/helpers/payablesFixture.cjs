const crypto = require("node:crypto");
function makePayablesFixture({ entries = [{ total: "100.00" }] } = {}) {
  const companyId = crypto.randomUUID(),
    branchId = crypto.randomUUID(),
    supplierId = crypto.randomUUID(),
    userId = crypto.randomUUID(),
    scope = {
      companyId,
      branchId,
      branchIds: [branchId],
      userId,
      isAdmin: false,
      permissions: [
        "merchandise.details",
        "merchandise.mark_paid",
        "merchandise.reports",
      ],
    };
  const stored = {
      entries: entries.map((e) => ({
        id: crypto.randomUUID(),
        branch_id: branchId,
        supplier_id: supplierId,
        companyId,
        source: "PURCHASE",
        payment_status: "PENDING",
        legacy_settled_amount: "0.00",
        payment_revision: 0,
        payment_balance_review_required: false,
        items: [{ quantity: 1, unit_cost: e.total }],
        paymentEntries: [],
        date: new Date(),
        ...e,
      })),
      payments: [],
      events: [],
    },
    match = (r, w = {}) =>
      (!w.id ||
        (typeof w.id === "object" ? w.id.in.includes(r.id) : w.id === r.id)) &&
      (!w.branch_id || r.branch_id === w.branch_id) &&
      (!w.company_id || r.company_id === w.company_id) &&
      (!w.supplier_id || r.supplier_id === w.supplier_id) &&
      (!w.branch?.company_id || r.companyId === w.branch.company_id);
  let fail = false;
  const receipt = (r) =>
    r && {
      ...r,
      company: { id: companyId, name: "QA empresa" },
      branch: { id: branchId, name: "QA sucursal" },
      supplier: { id: supplierId, name: "QA proveedor" },
      registeredBy: { id: userId, name: "QA usuario" },
      paymentMethod: r.payment_method_id
        ? { id: 1, name: "Transferencia", is_credit: false }
        : null,
      applications: stored.entries.flatMap((e) =>
        e.paymentEntries
          .filter((a) => a.supplier_payment_id === r.id)
          .map((a) => ({ ...a, incomingMerchandise: { id: e.id } })),
      ),
    };
  const db = {
    companyModule: {
      findMany: async () => [{ module_code: "merchandise", status: "ACTIVE" }],
    },
    branch: {
      findFirst: async ({ where }) =>
        where.id === branchId && where.company_id === companyId
          ? { id: branchId }
          : null,
    },
    supplier: {
      findFirst: async ({ where }) =>
        where.id === supplierId && where.company_id === companyId
          ? { id: supplierId }
          : null,
    },
    systemSetting: {
      findMany: async () => [{ key: "currency_code", value: "GTQ" }],
    },
    paymentMethod: {
      findUnique: async ({ where }) =>
        where.id === 1
          ? { id: 1, is_credit: false }
          : { id: 2, is_credit: true },
    },
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    incomingMerchandise: {
      findMany: async ({ where }) =>
        structuredClone(stored.entries.filter((e) => match(e, where))),
      findFirst: async ({ where }) =>
        structuredClone(stored.entries.find((e) => match(e, where)) || null),
      update: async ({ where, data }) => {
        const row = stored.entries.find((e) => e.id === where.id);
        for (const [k, v] of Object.entries(data))
          row[k] = k === "payment_revision" ? row[k] + v.increment : v;
        return row;
      },
    },
    supplierPayment: {
      findFirst: async ({ where }) =>
        receipt(stored.payments.find((r) => match(r, where))),
      findUnique: async ({ where }) => {
        const w = where.company_id_registered_by_request_key;
        return receipt(
          stored.payments.find(
            (r) =>
              r.company_id === w.company_id &&
              r.registered_by === w.registered_by &&
              r.request_key === w.request_key,
          ),
        );
      },
      create: async ({ data }) => {
        stored.payments.push({
          ...data,
          status: "POSTED",
          created_at: new Date(),
        });
        return receipt(stored.payments.at(-1));
      },
      update: async ({ where, data }) => {
        const row = stored.payments.find((p) => p.id === where.id);
        Object.assign(row, data);
        return receipt(row);
      },
    },
    incomingMerchandisePaymentEntry: {
      createMany: async ({ data }) => {
        if (fail) {
          fail = false;
          throw Error("Injected storage failure");
        }
        for (const a of data)
          stored.entries
            .find((e) => e.id === a.incoming_merchandise_id)
            .paymentEntries.push({
              ...a,
              id: crypto.randomUUID(),
              created_at: new Date(),
            });
        return { count: data.length };
      },
      updateMany: async ({ where, data }) => {
        for (const e of stored.entries)
          for (const a of e.paymentEntries)
            if (
              (!where.supplier_payment_id ||
                a.supplier_payment_id === where.supplier_payment_id) &&
              (!where.id || a.id === where.id)
            )
              Object.assign(a, data);
        return { count: 1 };
      },
      findFirst: async ({ where }) =>
        stored.entries
          .flatMap((e) => e.paymentEntries)
          .find(
            (a) =>
              a.id === where.id &&
              a.incoming_merchandise_id === where.incoming_merchandise_id,
          ) || null,
    },
    merchandisePaymentAuditEvent: {
      create: async ({ data }) => {
        stored.events.push(data);
        return data;
      },
    },
  };
  db.$transaction = async (fn) => {
    const before = structuredClone(stored);
    try {
      return await fn(db);
    } catch (e) {
      Object.assign(stored, before);
      throw e;
    }
  };
  const input = {
    requestKey: crypto.randomUUID(),
    supplierId,
    amount: entries.reduce((n, e) => n + Number(e.total), 0).toFixed(2),
    currencyCode: "GTQ",
    paidAt: "2026-10-14T12:00:00-06:00",
    paymentMethodId: 1,
    reference: null,
    notes: null,
    applications: stored.entries.map((e) => ({
      incomingId: e.id,
      amount: e.total,
      expectedRevision: e.payment_revision,
    })),
  };
  return {
    db,
    scope,
    input,
    stored,
    failNextWrite: () => {
      fail = true;
    },
  };
}
module.exports = { makePayablesFixture };
