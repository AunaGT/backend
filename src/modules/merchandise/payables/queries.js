const { Prisma } = require("@prisma/client"),
  { DateTime } = require("luxon"),
  { assertAccess } = require("./access"),
  { parsePayableFilters, uuid } = require("./validation"),
  { balanceOf } = require("./balance"),
  { loadReceipt, receiptDto, receiptInclude } = require("./payments"),
  { fail, toCents, fromCents, checked } = require("./money");
const S = Prisma.sql;
async function context(db, scope, raw) {
  await assertAccess(db, scope);
  const settings = Object.fromEntries(
    (
      await db.systemSetting.findMany({
        where: {
          company_id: scope.companyId,
          key: { in: ["timezone", "currency_code", "locale"] },
        },
        select: { key: true, value: true },
      })
    ).map((s) => [s.key, s.value]),
  );
  return {
    f: parsePayableFilters(raw, settings.timezone || "America/Guatemala"),
    currencyCode: settings.currency_code || "GTQ",
    locale: settings.locale || "es-GT",
  };
}
function base(scope) {
  const branch = scope.branchId
    ? S`b.id=${scope.branchId}::uuid`
    : scope.branchIds.length
      ? S`b.id IN (${Prisma.join(scope.branchIds.map((id) => S`${id}::uuid`))})`
      : S`false`;
  return S`WITH scoped AS (
 SELECT m.*,b.name AS branch_name,s.name AS supplier_name FROM incoming_merchandise m JOIN branches b ON b.id=m.branch_id JOIN suppliers s ON s.id=m.supplier_id
 WHERE b.company_id=${scope.companyId}::uuid AND s.company_id=${scope.companyId}::uuid AND ${branch} AND m.source='PURCHASE'
 ), totals AS (SELECT i.incoming_merchandise_id,SUM(i.quantity*i.unit_cost) AS total_amount,COUNT(*) AS n,BOOL_OR(i.quantity<0 OR i.unit_cost<0) AS invalid FROM incoming_merchandise_items i JOIN scoped s ON s.id=i.incoming_merchandise_id GROUP BY i.incoming_merchandise_id),
 paid AS (SELECT a.incoming_merchandise_id,SUM(a.amount) AS documented_paid,BOOL_OR(a.amount<0) AS invalid FROM incoming_merchandise_payment_entries a JOIN scoped s ON s.id=a.incoming_merchandise_id WHERE a.cancelled_at IS NULL GROUP BY a.incoming_merchandise_id),
 amounts AS (SELECT s.*,COALESCE(t.total_amount,0) AS total_amount,COALESCE(p.documented_paid,0) AS documented_paid,
 (s.payment_balance_review_required OR COALESCE(t.invalid,false) OR COALESCE(p.invalid,false) OR COALESCE(t.n,0)=0 OR COALESCE(t.total_amount,0)<0 OR COALESCE(p.documented_paid,0)+s.legacy_settled_amount>COALESCE(t.total_amount,0) OR COALESCE(t.total_amount,0)>90071992547409.91) AS needs_review
 FROM scoped s LEFT JOIN totals t ON t.incoming_merchandise_id=s.id LEFT JOIN paid p ON p.incoming_merchandise_id=s.id),
 p AS (SELECT a.*,CASE WHEN needs_review THEN NULL ELSE total_amount-documented_paid-legacy_settled_amount END AS balance_amount FROM amounts a)`;
}
function conditions(f, withState = true) {
  const parts = [S`true`];
  if (f.supplierId) parts.push(S`p.supplier_id=${f.supplierId}::uuid`);
  if (f.search) {
    const q = `%${f.search.replace(/[\\%_]/g, "\\$&")}%`;
    parts.push(
      S`(p.supplier_name ILIKE ${q} OR p.id::text ILIKE ${q} OR COALESCE(p.payment_reference,'') ILIKE ${q})`,
    );
  }
  for (const [key, col, op] of [
    [
      "dateFrom",
      S`(p.date AT TIME ZONE 'UTC' AT TIME ZONE ${f.timezone})::date`,
      S`>=`,
    ],
    [
      "dateTo",
      S`(p.date AT TIME ZONE 'UTC' AT TIME ZONE ${f.timezone})::date`,
      S`<=`,
    ],
    ["dueFrom", S`p.due_date::date`, S`>=`],
    ["dueTo", S`p.due_date::date`, S`<=`],
  ])
    if (f[key]) parts.push(S`${col} ${op} ${f[key]}::date`);
  if (withState) {
    if (f.state === "OPEN")
      parts.push(S`(p.balance_amount>0 OR p.needs_review)`);
    if (f.state === "PAID")
      parts.push(S`p.balance_amount=0 AND NOT p.needs_review`);
    if (f.state === "REVIEW") parts.push(S`p.needs_review`);
    if (f.state === "OVERDUE")
      parts.push(
        S`p.balance_amount>0 AND p.due_date::date<${f.localDay}::date`,
      );
    if (f.state === "UPCOMING")
      parts.push(
        S`p.balance_amount>0 AND p.due_date::date BETWEEN ${f.localDay}::date AND ${f.localDay}::date+30`,
      );
  }
  return Prisma.join(parts, " AND ");
}
const projection = S`p.id,p.supplier_id,p.supplier_name,p.branch_id,p.branch_name,p.date,p.due_date,p.source,p.payment_revision,p.legacy_settled_amount::text,p.total_amount::text,p.documented_paid::text,p.needs_review AS payment_balance_review_required`;
function entryDto(r, f) {
  const due = r.due_date
      ? new Date(r.due_date).toISOString().slice(0, 10)
      : null,
    days = due
      ? Math.max(
          0,
          Math.floor(
            DateTime.fromISO(f.localDay).diff(DateTime.fromISO(due), "days")
              .days,
          ),
        )
      : 0,
    result = balanceOf(r);
  return {
    id: r.id,
    reference: r.id.slice(0, 8).toUpperCase(),
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    branchId: r.branch_id,
    branchName: r.branch_name,
    date: new Date(r.date).toISOString(),
    dueDate: due,
    ...result,
    overdue:
      !!due &&
      due < f.localDay &&
      result.balance !== null &&
      toCents(result.balance) > 0,
    overdueDays: result.balance && toCents(result.balance) > 0 ? days : 0,
  };
}
async function listPayableEntries(db, scope, raw = {}) {
  const { f } = await context(db, scope, raw),
    cte = base(scope),
    where = conditions(f),
    fetch = (page) =>
      db.$queryRaw(
        S`${cte} SELECT ${projection},COUNT(*) OVER() AS total_count FROM p WHERE ${where} ORDER BY p.due_date ASC NULLS LAST,p.date,p.id LIMIT ${f.pageSize} OFFSET ${(page - 1) * f.pageSize}`,
      );
  let rows = await fetch(f.page),
    totalItems = Number(
      rows[0]?.total_count ??
        (
          await db.$queryRaw(
            S`${cte} SELECT COUNT(*) AS total_count FROM p WHERE ${where}`,
          )
        )[0]?.total_count ??
        0,
    ),
    totalPages = Math.max(1, Math.ceil(totalItems / f.pageSize)),
    page = Math.min(f.page, totalPages);
  if (page !== f.page) rows = await fetch(page);
  return {
    items: rows.map((r) => entryDto(r, f)),
    page,
    pageSize: f.pageSize,
    totalItems,
    totalPages,
  };
}
async function payablesSummary(db, scope, raw = {}) {
  const { f } = await context(db, scope, raw),
    rows =
      await db.$queryRaw(S`${base(scope)} SELECT COALESCE(SUM(p.balance_amount) FILTER(WHERE p.balance_amount>0),0)::text AS pending,
 COALESCE(SUM(p.balance_amount) FILTER(WHERE p.balance_amount>0 AND p.due_date::date<${f.localDay}::date),0)::text AS overdue,
 COALESCE(SUM(p.balance_amount) FILTER(WHERE p.balance_amount>0 AND p.due_date::date BETWEEN ${f.localDay}::date AND ${f.localDay}::date+30),0)::text AS upcoming,
 COUNT(DISTINCT p.supplier_id) FILTER(WHERE p.balance_amount>0) AS supplier_count,COUNT(*) FILTER(WHERE p.needs_review) AS review_count FROM p WHERE ${conditions(f, false)}`),
    r = rows[0] || {};
  return {
    pending: r.pending || "0.00",
    overdue: r.overdue || "0.00",
    upcoming30Days: r.upcoming || "0.00",
    supplierCount: Number(r.supplier_count || 0),
    reviewCount: Number(r.review_count || 0),
    complete: !Number(r.review_count || 0),
    asOf: new Date().toISOString(),
    timezone: f.timezone,
  };
}
async function listPayableSuppliers(db, scope, raw = {}) {
  const { f } = await context(db, scope, raw),
    rows = await db.$queryRaw(
      S`${base(scope)} SELECT p.supplier_id AS id,p.supplier_name AS name,COALESCE(SUM(p.balance_amount) FILTER(WHERE p.balance_amount>0),0)::text AS pending,COALESCE(SUM(p.balance_amount) FILTER(WHERE p.balance_amount>0 AND p.due_date::date<${f.localDay}::date),0)::text AS overdue,COUNT(*) AS entries,MIN(p.due_date) FILTER(WHERE p.balance_amount>0) AS next_due,COUNT(*) FILTER(WHERE p.needs_review) AS review_count,COUNT(*) OVER() AS total_count FROM p WHERE ${conditions(f, false)} GROUP BY p.supplier_id,p.supplier_name ORDER BY p.supplier_name,p.supplier_id LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
    );
  return {
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      pending: r.pending,
      overdue: r.overdue,
      entries: Number(r.entries),
      nextDue: r.next_due
        ? new Date(r.next_due).toISOString().slice(0, 10)
        : null,
      reviewCount: Number(r.review_count),
    })),
    page: f.page,
    pageSize: f.pageSize,
    totalItems: Number(rows[0]?.total_count || 0),
    totalPages: Math.max(
      1,
      Math.ceil(Number(rows[0]?.total_count || 0) / f.pageSize),
    ),
  };
}
async function payablesAging(db, scope, raw = {}) {
  const { f } = await context(db, scope, raw),
    rows =
      await db.$queryRaw(S`${base(scope)} SELECT p.supplier_id AS id,p.supplier_name AS name,
 COALESCE(SUM(p.balance_amount) FILTER(WHERE p.due_date::date>=${f.localDay}::date),0)::text AS current,
 COALESCE(SUM(p.balance_amount) FILTER(WHERE ${f.localDay}::date-p.due_date::date BETWEEN 1 AND 30),0)::text AS d1_30,
 COALESCE(SUM(p.balance_amount) FILTER(WHERE ${f.localDay}::date-p.due_date::date BETWEEN 31 AND 60),0)::text AS d31_60,
 COALESCE(SUM(p.balance_amount) FILTER(WHERE ${f.localDay}::date-p.due_date::date BETWEEN 61 AND 90),0)::text AS d61_90,
 COALESCE(SUM(p.balance_amount) FILTER(WHERE ${f.localDay}::date-p.due_date::date>90),0)::text AS d90_plus,
 COALESCE(SUM(p.balance_amount) FILTER(WHERE p.due_date IS NULL),0)::text AS undated,
 COUNT(*) FILTER(WHERE p.needs_review) AS review_count,COUNT(*) OVER() AS total_count
 FROM p WHERE ${conditions(f, false)} AND (p.balance_amount>0 OR p.needs_review) GROUP BY p.supplier_id,p.supplier_name ORDER BY p.supplier_name,p.supplier_id LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`);
  return {
    items: rows.map((r) => ({
      ...r,
      review_count: Number(r.review_count),
      total_count: undefined,
    })),
    page: f.page,
    pageSize: f.pageSize,
    totalItems: Number(rows[0]?.total_count || 0),
    totalPages: Math.max(
      1,
      Math.ceil(Number(rows[0]?.total_count || 0) / f.pageSize),
    ),
  };
}
async function supplierPaymentReceipt(db, scope, id) {
  uuid(id);
  await assertAccess(db, scope);
  return receiptDto(await loadReceipt(db, scope, id));
}
async function supplierStatement(db, scope, id, raw = {}) {
  uuid(id);
  const { f } = await context(db, scope, raw),
    supplier = await db.supplier.findFirst({
      where: { id, company_id: scope.companyId },
      select: { id: true, name: true, tax_id: true, address: true },
    });
  if (!supplier) fail("Proveedor no disponible", 404, "NOT_FOUND");
  const branch = scope.branchId || { in: scope.branchIds },
    where = { company_id: scope.companyId, branch_id: branch, supplier_id: id },
    auditWhere = {
      company_id: scope.companyId,
      incomingMerchandise: { supplier_id: id, branch_id: branch },
    },
    paymentPage = f.paymentPage || 1,
    auditPage = f.auditPage || 1;
  const [entries, summary, payments, totalPayments, audit, totalAudit] =
    await Promise.all([
      listPayableEntries(db, scope, {
        ...raw,
        supplierId: id,
        page: f.entryPage || f.page,
      }),
      payablesSummary(db, scope, { ...raw, supplierId: id }),
      db.supplierPayment.findMany({
        where,
        include: receiptInclude,
        orderBy: [{ paid_at: "desc" }, { id: "desc" }],
        take: f.pageSize,
        skip: (paymentPage - 1) * f.pageSize,
      }),
      db.supplierPayment.count({ where }),
      db.merchandisePaymentAuditEvent.findMany({
        where: auditWhere,
        select: {
          id: true,
          action: true,
          reason: true,
          before: true,
          after: true,
          created_at: true,
          actor: { select: { id: true, name: true } },
        },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: f.pageSize,
        skip: (auditPage - 1) * f.pageSize,
      }),
      db.merchandisePaymentAuditEvent.count({ where: auditWhere }),
    ]);
  return {
    supplier,
    summary,
    entries,
    payments: {
      items: payments.map(receiptDto),
      page: paymentPage,
      pageSize: f.pageSize,
      totalItems: totalPayments,
      totalPages: Math.max(1, Math.ceil(totalPayments / f.pageSize)),
    },
    audit: {
      items: audit,
      page: auditPage,
      pageSize: f.pageSize,
      totalItems: totalAudit,
      totalPages: Math.max(1, Math.ceil(totalAudit / f.pageSize)),
    },
  };
}
async function exportPayables(db, scope, raw = {}) {
  await assertAccess(db, scope, { exporting: true });
  const { f, currencyCode, locale } = await context(db, scope, raw),
    rows = await db.$queryRaw(
      S`${base(scope)} SELECT ${projection} FROM p WHERE ${conditions(f)} ORDER BY p.supplier_name,p.due_date NULLS LAST,p.date,p.id LIMIT 10001`,
    );
  if (rows.length > 10000)
    fail(
      "Reduce los filtros: el documento supera 10000 entradas",
      413,
      "EXPORT_LIMIT",
    );
  const company = await db.company.findUnique({
      where: { id: scope.companyId },
      select: { id: true, name: true, logo_url: true },
    }),
    items = rows.map((r) => entryDto(r, f)),
    pending = items.reduce(
      (n, r) => (r.balance === null ? n : checked(n + toCents(r.balance))),
      0,
    );
  return {
    items,
    asOf: new Date().toISOString(),
    filters: raw,
    summary: {
      pending: fromCents(pending),
      reviewCount: items.filter((r) => r.status === "REVIEW").length,
      complete: items.every((r) => r.status !== "REVIEW"),
    },
    branding: {
      companyId: company.id,
      companyName: company.name,
      companyLogoUrl: company.logo_url,
      currencyCode,
      locale,
      timezone: f.timezone,
      scopeLabel: scope.branchId
        ? "Sucursal seleccionada"
        : "Sucursales autorizadas",
      branches: [
        ...new Map(
          items.map((r) => [
            r.branchId,
            { id: r.branchId, name: r.branchName },
          ]),
        ).values(),
      ],
    },
  };
}
async function payableSelection(db, scope, raw) {
  const { object } = require("./validation");
  object(raw, ["ids"]);
  if (
    !Array.isArray(raw.ids) ||
    !raw.ids.length ||
    raw.ids.length > 100 ||
    new Set(raw.ids).size !== raw.ids.length
  )
    fail("Selecciona de 1 a 100 entradas diferentes");
  raw.ids.forEach(uuid);
  const { f } = await context(db, scope, {});
  const rows = await db.$queryRaw(
    S`${base(scope)} SELECT ${projection} FROM p WHERE p.id IN (${Prisma.join(raw.ids.map((id) => S`${id}::uuid`))}) ORDER BY p.due_date NULLS LAST,p.date,p.id`,
  );
  if (rows.length !== raw.ids.length)
    fail(
      "Una entrada no está disponible en este alcance",
      404,
      "ENTRY_UNAVAILABLE",
    );
  if (new Set(rows.map((r) => r.supplier_id)).size !== 1)
    fail("Selecciona entradas de un solo proveedor");
  return rows.map((r) => entryDto(r, f));
}
module.exports = {
  listPayableEntries,
  payablesSummary,
  listPayableSuppliers,
  payablesAging,
  supplierStatement,
  supplierPaymentReceipt,
  exportPayables,
  payableSelection,
  entryDto,
};
