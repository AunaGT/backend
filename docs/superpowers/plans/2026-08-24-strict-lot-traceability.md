# Strict Lot Traceability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee that every inventory unit belongs to a lot in its physical location while requiring user-entered lot data only for expiry-controlled products.

**Architecture:** Keep `product_stock_locations` as the physical source of truth and make lot writes part of the same Prisma transaction. Shared stock-delta services create automatic lots for ordinary positive deltas and consume location-scoped lots for negative deltas; explicit incoming and transfer flows opt into supplying their own lot metadata. The product API exposes reconciliation, and the UI shows it without adding steps to normal POS or warehouse work.

**Tech Stack:** Node.js CommonJS, Prisma 6/PostgreSQL, React 18, TypeScript, TanStack Query, existing assert-based self-checks and database E2E scripts.

**Spec:** `docs/superpowers/specs/2026-08-24-strict-lot-traceability-design.md`

## Global Constraints

- No new runtime or test dependencies.
- Normal products must not gain required lot fields; missing metadata creates an automatic internal lot.
- `tracks_expiry = true` requires supplier lot code and expiry date whenever stock is created manually or by incoming merchandise.
- `SUM(product_lots.qty_remaining)` must equal `product_stock_locations.stock` per product and location after every committed stock transaction.
- Quantity-changing lot operations must throw and roll back on mismatch; expiry-alert refresh may remain best-effort.
- Existing POS interaction remains unchanged.
- Preserve unrelated user changes, including the original frontend `tsconfig.app.tsbuildinfo` modification outside the isolated worktree.

---

### Task 1: Strict lot primitives and schema marker

**Files:**
- Modify: `deposito-backend/prisma/schema.prisma`
- Create: `deposito-backend/prisma/migrations/20260824120000_strict_lot_traceability/migration.sql`
- Modify: `deposito-backend/src/services/lots.js`
- Modify: `deposito-backend/tests/lots.selfcheck.js`

**Interfaces:**
- Produces: `planConsumeStrict(lots, qty, context)` returning the existing consumption plan or throwing an error with `code = "LOT_STOCK_MISMATCH"`.
- Produces: `createAutomaticLots(tx, branchId, locationDeltas, context)` where each delta is `{ product_id, location_id, qty }` with positive `qty`.
- Produces: `consumeLotsForLocations(tx, branchId, locationDeltas)` returning `Map<productId, LotSnapshot[]>`.
- Adds: `ProductLot.is_system_generated: boolean`.

- [ ] **Step 1: Write the failing pure tests**

Add literal assertions to `tests/lots.selfcheck.js`:

```js
assert.throws(
  () => planConsumeStrict([{ id: 'a', qty_remaining: 2 }], 3, { productId: 'p', locationId: 'l' }),
  (e) => e.code === 'LOT_STOCK_MISMATCH' && e.shortfall === 1,
  'strict consumption rejects stock without matching lots'
)
assert.deepStrictEqual(
  planConsumeStrict([{ id: 'a', qty_remaining: 2 }, { id: 'b', qty_remaining: 3 }], 4),
  [{ lotId: 'a', take: 2 }, { lotId: 'b', take: 2 }]
)
```

- [ ] **Step 2: Run the self-check and verify RED**

Run: `node tests/lots.selfcheck.js`

Expected: FAIL because `planConsumeStrict` is not exported.

- [ ] **Step 3: Implement the strict pure function**

Implement `planConsumeStrict` by calling the existing `planConsume`, summing `take`, and throwing:

```js
const err = new Error(`Los lotes no cubren ${shortfall} unidad(es) del inventario físico`)
err.status = 409
err.code = 'LOT_STOCK_MISMATCH'
err.shortfall = shortfall
err.productId = context.productId || null
err.locationId = context.locationId || null
throw err
```

Do not change the existing FEFO ordering.

- [ ] **Step 4: Run the self-check and verify GREEN**

Run: `node tests/lots.selfcheck.js`

Expected: `lots.selfcheck OK`.

- [ ] **Step 5: Add schema and migration**

Add `is_system_generated Boolean @default(false)` to `ProductLot`. The migration must add the column, abort when traced stock exceeds physical stock, create a generated `LEGACY-<location-prefix>` lot for every positive location gap, and recheck the invariant. Existing supplier lots remain unchanged.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260824120000_strict_lot_traceability tests/lots.selfcheck.js src/services/lots.js
git commit -m "feat(inventory): add strict lot primitives"
```

### Task 2: Enforce lots in the shared stock transaction

**Files:**
- Modify: `deposito-backend/src/services/stockLocations.js`
- Modify: `deposito-backend/src/services/bomStock.js`
- Create: `deposito-backend/tests/lotInvariant.e2e.js`

**Interfaces:**
- `applyBranchDelta(...)` continues returning the rows produced by `applyLocationDeltas`.
- `deductStockMap(..., ctx)` accepts optional `ctx.lotSnapshots: Map` and fills it with consumed lot metadata.
- `ctx.lotsManagedExternally === true` skips automatic lot mutation only for a caller that writes explicit lots in the same transaction.
- Positive default behavior creates automatic lots; negative default behavior consumes strict FEFO lots in the physical dispatch locations.

- [ ] **Step 1: Write the failing database test**

Create `tests/lotInvariant.e2e.js` using the setup style in `tests/locations.e2e.js`:

```js
await prisma.$transaction((tx) => restoreStockMap(
  tx, new Map([[product.id, 6]]), branch.id,
  { reason: 'MANUAL_ADJUST', locationId: location.id }
))
assert(await physical(location.id, product.id) === 6, 'physical stock is six')
assert(await traced(location.id, product.id) === 6, 'automatic lot is also six')
```

Then delete the automatic lot, attempt a one-unit deduction, and assert `LOT_STOCK_MISMATCH` plus unchanged physical stock.

- [ ] **Step 2: Run the E2E test and verify RED**

Run:

```bash
npx prisma migrate deploy
node tests/lotInvariant.e2e.js
```

Expected: FAIL because positive stock does not create lots.

- [ ] **Step 3: Implement automatic positive lots**

Capture `locationRows` from `applyBranchDelta`. For `sign > 0` and no external management, call `createAutomaticLots` with the positive location deltas before updating branch/company mirrors.

- [ ] **Step 4: Implement strict negative consumption**

Convert negative `locationRows` to positive requested quantities, call `consumeLotsForLocations`, and merge snapshots into `ctx.lotSnapshots` when provided. Remove quantity-changing advisory catches so a mismatch aborts the transaction.

- [ ] **Step 5: Run focused and existing stock checks**

```bash
node tests/lotInvariant.e2e.js
node tests/lots.selfcheck.js
node tests/locations.e2e.js
```

Expected: all scripts exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/services/stockLocations.js src/services/bomStock.js src/services/lots.js tests/lotInvariant.e2e.js
git commit -m "fix(inventory): keep physical stock and lots atomic"
```

### Task 3: Adapt every explicit inventory flow

**Files:**
- Modify: `deposito-backend/src/controllers/products.controller.js`
- Modify: `deposito-backend/src/controllers/transfers.controller.js`
- Modify: `deposito-backend/src/controllers/sales.controller.js`
- Modify: `deposito-backend/src/controllers/returns.controller.js`
- Modify: `deposito-backend/src/controllers/stockMoves.controller.js`
- Modify: `deposito-backend/src/services/stockLocations.js`
- Modify: `deposito-backend/src/services/bomStock.js`
- Modify: `deposito-backend/tests/lotInvariant.e2e.js`

**Interfaces:**
- Explicit incoming passes `{ lotsManagedExternally: true, locationId }` and creates exactly one user lot.
- Transfer send passes `lotSnapshots: new Map()`; receive recreates snapshots and uses an automatic lot only for a legacy snapshot shortfall.
- Internal moves strictly consume source lots and recreate identical metadata at the destination.
- Lot edits and write-offs pass both `lotsManagedExternally: true` and exact `lot.location_id`.

- [ ] **Step 1: Extend failing E2E scenarios**

After explicit receipt, sale, return, adjustment, internal move, transfer, inventory count, and kit assembly, call:

```js
await assertLocationInvariant(product.id, source.id)
await assertLocationInvariant(product.id, destination.id)
```

Assert that internal moves preserve lot code and expiry.

- [ ] **Step 2: Run and verify RED**

Run: `node tests/lotInvariant.e2e.js`

Expected: FAIL on the first duplicate automatic/explicit lot or advisory path.

- [ ] **Step 3: Adapt callers one flow at a time**

Add only the `lotsManagedExternally`, `lotSnapshots`, or exact `locationId` context each flow needs. Remove duplicate controller-level FEFO calls once shared deduction owns consumption.

- [ ] **Step 4: Fix lot quantity editing at the real location**

```js
const lotCtx = {
  reason: 'MANUAL_ADJUST', refType: 'product_lot', refId: String(lotId),
  userId: req.user?.sub || null, locationId: lot.location_id,
  lotsManagedExternally: true,
}
```

Reject editing a legacy lot with unknown location until reconciled.

- [ ] **Step 5: Run the E2E matrix**

```bash
node tests/lotInvariant.e2e.js
node tests/locations.e2e.js
node tests/inTransit.e2e.js
node tests/saleCancel.e2e.js
node tests/stockAdjustPosting.e2e.js
node tests/bomStock.selfcheck.js
```

- [ ] **Step 6: Commit**

```bash
git add src/controllers src/services tests/lotInvariant.e2e.js
git commit -m "fix(inventory): trace lots through every stock flow"
```

### Task 4: Require metadata only for controlled products

**Files:**
- Modify: `deposito-backend/src/controllers/products.controller.js`
- Modify: `deposito-backend/src/controllers/stockMoves.controller.js`
- Modify: `deposito-frontend/src/pages/RegisterIncomingMerchandise.tsx`
- Modify: `deposito-frontend/src/components/stock/StockMovesPage.tsx`
- Modify: `deposito-backend/tests/lotInvariant.e2e.js`

**Interfaces:**
- Positive adjustment lines accept optional `lot_code` and `expiry_date`.
- Backend returns HTTP 400 naming the controlled product and missing field.

- [ ] **Step 1: Write failing controller cases**

Assert missing lot code and missing expiry independently return 400 for a controlled product. Assert an ordinary product succeeds without either field and receives an automatic lot.

- [ ] **Step 2: Run and verify RED**

Run: `node tests/lotInvariant.e2e.js`

- [ ] **Step 3: Implement backend validation**

Validate inside the transaction after loading products. Use concise messages:

```text
"<producto>" requiere numero de lote
"<producto>" requiere fecha de caducidad
```

- [ ] **Step 4: Implement progressive disclosure**

Normal products keep optional fields and show `Si lo dejas vacio, se crea una partida interna automaticamente.` Controlled products show `*` and disable submission until both values exist.

- [ ] **Step 5: Verify backend and frontend**

Run `node tests/lotInvariant.e2e.js` in backend and `npm run build` in frontend.

- [ ] **Step 6: Commit both repositories**

Backend commit: `feat(inventory): require metadata for controlled lots`

Frontend commit: `feat(inventory): keep lot entry progressive`

### Task 5: Reconciliation API and product detail

**Files:**
- Modify: `deposito-backend/src/controllers/products.controller.js`
- Modify: `deposito-frontend/src/components/products/ProductLotsSection.tsx`
- Modify: `deposito-frontend/src/components/products/ProductDetailPage.tsx`
- Modify: `deposito-frontend/src/types/product.ts`
- Modify: `deposito-backend/tests/lotInvariant.e2e.js`

**Interfaces:**
- `GET /api/products/:id/lots` returns lot location, `is_system_generated`, and `{ physical, traced, difference, consistent }`.
- `difference = physical - traced`; `consistent = difference === 0`.

- [ ] **Step 1: Write failing API assertions**

```js
assert.deepStrictEqual(response.body.reconciliation, {
  physical: 20, traced: 20, difference: 0, consistent: true,
})
```

Also assert each lot includes warehouse and location codes.

- [ ] **Step 2: Run and verify RED**

Run: `node tests/lotInvariant.e2e.js`

- [ ] **Step 3: Implement grouped backend reconciliation**

Fetch branch-scoped lots with location/warehouse, sum `qty_remaining`, sum physical location stock, and return the summary without one query per lot.

- [ ] **Step 4: Update the detail UI**

Render `Fisico 20 | Trazado 20 | Diferencia 0`, add `Ubicacion` and `Origen` columns, label generated rows `Partida automatica`, and show a destructive alert only when inconsistent. Rename copy to `Exige lote y caducidad`.

- [ ] **Step 5: Verify**

Run backend E2E, frontend `npm run build`, and ESLint only on touched frontend files.

- [ ] **Step 6: Commit both repositories**

Backend commit: `feat(inventory): report lot reconciliation`

Frontend commit: `feat(inventory): show lot reconciliation clearly`

### Task 6: Full verification and browser regression

**Files:**
- Modify only if verification exposes an in-scope defect.

**Interfaces:**
- No new interfaces.

- [ ] **Step 1: Verify backend from a clean test database**

```bash
npx prisma generate
npx prisma migrate deploy
node tests/lots.selfcheck.js
node tests/lotInvariant.e2e.js
node tests/locations.e2e.js
node tests/inTransit.e2e.js
node tests/saleCancel.e2e.js
node tests/stockAdjustPosting.e2e.js
node tests/bomStock.selfcheck.js
```

- [ ] **Step 2: Verify frontend**

```bash
npm run build
npx eslint src/components/products/ProductLotsSection.tsx src/components/products/ProductDetailPage.tsx src/pages/RegisterIncomingMerchandise.tsx src/types/product.ts
```

- [ ] **Step 3: Reproduce the original local-browser flow**

For `QA Agua Purificada 600ml` in Mixco, verify migration reaches 20 physical/20 traced; receive an ordinary product without metadata; move it; sell one unit; then verify a controlled product blocks missing metadata and succeeds with supplier lot plus expiry.

- [ ] **Step 4: Review both repository diffs**

Run `git diff --check`, `git status --short`, and `git log --oneline -6` in both worktrees.

- [ ] **Step 5: Record evidence**

Report exact command exits, migrated discrepancy counts, final physical/traced totals, and any skipped scenario. Do not claim completion if an invariant or command failed.
