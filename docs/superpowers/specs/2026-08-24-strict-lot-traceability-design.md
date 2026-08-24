# Strict Lot Traceability Design

## Objective

Make every physical inventory unit traceable to a `ProductLot` row while keeping daily operations practical. Products that require expiry control must use a supplier lot and expiry date; all other stock receives an automatic internal lot when the user does not provide one.

The invariant is enforced per product, branch, and location:

```text
SUM(product_lots.qty_remaining) = product_stock_locations.stock
```

`product_stock_locations` remains the physical stock source of truth. Lot operations become part of the same database transaction and may no longer fail silently.

## Product policy

The existing `tracks_expiry` flag defines the input policy:

- `tracks_expiry = true`: supplier lot code and expiry date are mandatory for incoming merchandise and positive manual adjustments.
- `tracks_expiry = false`: supplier lot and expiry are optional. If omitted, the backend creates an internal lot with an `AUTO-YYMMDD-XXXX` code and no expiry date.
- All products use lot rows internally. The distinction is whether the operator must provide traceability metadata, not whether stock is traced.

An `is_system_generated` boolean on `ProductLot` identifies internal lots without relying on a code prefix.

## User experience constraint

Traceability must not add routine work for normal products:

- Normal products keep the current short forms. Lot fields stay optional and the automatic internal lot is explained in one short helper message.
- Products marked `tracks_expiry` reveal and require supplier lot plus expiry date at the point where stock is created.
- Validation errors name the product and the missing field; the operator is never asked to understand reconciliation internals.
- Reconciliation details live on the product detail page and reports, not in the normal POS flow.
- POS continues to scan and sell normally; strict lot consumption happens in the transaction without extra cashier input.

## Stock transaction boundary

The current defect exists because physical stock is updated by shared stock services while lot changes are attempted separately by controllers and intentionally swallow errors.

The backend will provide strict tracked-stock operations in the shared inventory service:

- Positive deltas update physical stock and create or restore lots in the exact locations credited by the operation.
- Negative deltas plan the physical dispatch first, then consume lots FEFO inside those same locations.
- Internal moves consume lots from the source location and recreate the same lot metadata in the destination location without changing branch totals.
- Transfer dispatch returns the consumed lot snapshot; transfer receipt recreates that snapshot at the chosen destination.
- Sale returns restore the lots consumed by the sale when that snapshot exists; legacy returns receive an automatic lot at the returned location.
- Existing kit assembly consumes component lots and creates an automatic lot for assembled kit stock.

Every operation runs inside its existing Prisma transaction. A missing lot quantity raises `LOT_STOCK_MISMATCH` and rolls back physical stock, branch stock, company stock, accounting side effects, and lot changes together.

The old advisory `try/catch` behavior is removed from stock-changing lot functions. Expiry-alert synchronization may remain best-effort because it does not change inventory quantities.

## Reconciliation and migration

A preflight audit groups physical and traced quantities by product, branch, and location.

For each positive gap (`physical > traced`), the migration creates one system-generated `LEGACY-YYMMDD-XXXX` lot in that location for the exact difference. This covers initial balances, old imports, and historical positive adjustments.

For a negative gap (`traced > physical`), deployment stops with a report. The migration must not silently consume or delete supplier lots because the physical cause is ambiguous.

The migration is safe to rerun at the SQL level by marking generated reconciliation rows and only filling the current positive difference.

The current QA example becomes:

```text
Bodega Mixco / GENERAL             physical 5   traced 5
Secundaria / PASILLOAESTANTE1QA    physical 15  traced 15
Branch total                       physical 20  traced 20
```

The existing nine traced units remain unchanged; eleven units are assigned to generated legacy lots in their physical locations.

## API and interface

`GET /api/products/:id/lots` will include each lot's location and a reconciliation summary:

```json
{
  "lots": [],
  "reconciliation": {
    "physical": 20,
    "traced": 20,
    "difference": 0,
    "consistent": true
  }
}
```

The product detail page will:

- show `Stock fisico`, `Stock trazado`, and `Diferencia`;
- show the warehouse and location for every lot;
- label generated rows as `Partida automatica`;
- show a destructive warning when the difference is non-zero;
- change the product setting copy from `Controla caducidad (lotes)` to `Exige lote y caducidad`.

The incoming-merchandise form will explain that normal products receive an automatic internal lot when lot metadata is omitted. Controlled products will block submission until both supplier lot and expiry date are present.

## Validation and permissions

- Lot location must belong to the active branch.
- Quantities must be positive integers.
- Explicit lot metadata is validated at the API boundary; frontend validation is only an early user-facing check.
- Existing permissions for incoming merchandise, stock adjustments, and lot correction remain unchanged.
- Editing a lot quantity adjusts the exact `lot.location_id`, not a default warehouse.

## Testing

Testing follows red-green TDD and uses the existing Node self-check and PostgreSQL end-to-end style.

Required regression scenarios:

1. A normal product receipt without metadata creates an automatic lot in the receiving location.
2. A controlled product receipt rejects a missing supplier lot or expiry date.
3. A positive manual adjustment creates an automatic lot in the adjusted location.
4. A negative adjustment consumes FEFO lots in that location.
5. A sale, return, internal move, transfer send/receive, inventory count, and kit assembly preserve the location invariant.
6. A forced lot shortfall aborts the entire stock transaction with `LOT_STOCK_MISMATCH`.
7. The migration fills positive gaps and rejects negative gaps.
8. The product API returns the reconciliation summary and locations.
9. The frontend build succeeds and the detail page displays the three reconciliation values and lot locations.

## Scope exclusions

- No separate lot-movement ledger is introduced in this change; the existing stock movement ledger and lot receipt/remaining quantities remain the audit sources.
- No arbitrary split/merge lot user interface is added.
- No supplier-lot uniqueness rule is added because the same supplier code may legitimately appear in multiple locations or receipts.
