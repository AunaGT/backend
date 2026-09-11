# Inventory/Products Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Inventory/Products through synchronized frontend and backend manifests while preserving every legacy page, router, HTTP contract, tenant check, and permission.

**Architecture:** Keep the current monolith and legacy implementations in place. The frontend manifest becomes the public lazy-page catalog for `inventory`; the backend manifest becomes the public catalog for the existing `/products`, `/stock`, and `/warehouses` routers, which remain mounted after tenant resolution and behind the commercial module guard.

**Tech Stack:** React 18, TypeScript, Vite, React Router, Express 5, Node.js test runner, Prisma 6.

**Spec:** `docs/superpowers/specs/2026-09-11-inventory-products-design.md`

## Global Constraints

- Work only on branch `Modularizado` in `deposito-frontend` and `deposito-backend`.
- Module code is exactly `inventory`; dependencies are exactly `[]`.
- Do not change HTTP paths, request/response shapes, controller behavior, authentication, tenant resolution, or permissions.
- Keep `inventory-count` and `merchandise` independent.
- Keep legacy pages, components, hooks, services, controllers, and routes in place.
- Do not create or modify `.env` files and do not add dependencies.
- Commit frontend and backend implementation separately.

---

### Task 1: Protect Inventory activation and manifest contracts

**Files:**

- Modify: `tests/modules.registry.test.js`
- Create: `src/modules/inventory/manifest.js`
- Modify: `src/routes/index.js`
- Verify: `src/modules/platform/registry.js`

**Interfaces:**

- Consumes: `resolveEffectiveModules(rows, now)`, `requireModule(code)`, and the existing routers in `src/routes/`.
- Produces: `inventoryModule` with `{ code, dependencies, routes }`, where each route has `{ routePrefix, loadRouter }`.

- [ ] **Step 1: Write failing inventory behavior and manifest tests**

Add the manifest import and replace the generic trial test with inventory-specific tests. Keep the existing dependency test because it proves that disabling Inventory blocks dependents.

```js
const inventoryModule = require('../src/modules/inventory/manifest')

test('inventario activo explícitamente queda disponible', () => {
  const inventory = resolveEffectiveModules([
    { module_code: 'inventory', status: 'ACTIVE' },
  ]).find((module) => module.code === 'inventory')

  assert.equal(inventory.status, 'ACTIVE')
  assert.equal(inventory.effectiveEnabled, true)
  assert.equal(inventory.persisted, true)
})

test('una prueba vencida de inventario queda desactivada efectivamente', () => {
  const inventory = resolveEffectiveModules([
    {
      module_code: 'inventory',
      status: 'TRIAL',
      trial_ends_at: new Date('2026-01-01T00:00:00.000Z'),
    },
  ], new Date('2026-01-02T00:00:00.000Z'))
    .find((module) => module.code === 'inventory')

  assert.equal(inventory.status, 'TRIAL')
  assert.equal(inventory.effectiveEnabled, false)
})

test('el manifiesto de inventario coincide con el registro y conserva prefijos HTTP', () => {
  const definition = MODULE_DEFINITIONS.find((module) => module.code === inventoryModule.code)
  assert.ok(definition)
  assert.deepEqual([...inventoryModule.dependencies], [...definition.dependencies])
  assert.deepEqual(
    inventoryModule.routes.map((route) => route.routePrefix),
    ['/products', '/stock', '/warehouses']
  )
  assert.equal(inventoryModule.routes.every((route) => typeof route.loadRouter === 'function'), true)
})
```

The production mutations caught are: treating an explicit ACTIVE row as disabled, ignoring trial expiry, removing Inventory dependencies from effective resolution, or changing/omitting a legacy API prefix.

- [ ] **Step 2: Run the module suite and verify RED**

Run:

```bash
cd deposito-backend && npm run test:modules
```

Expected: FAIL with `Cannot find module '../src/modules/inventory/manifest'`. The failure must be caused by the missing manifest, not by syntax or fixture errors.

- [ ] **Step 3: Create the minimal backend manifest**

Create `src/modules/inventory/manifest.js`:

```js
const routes = Object.freeze([
  Object.freeze({
    routePrefix: '/products',
    loadRouter: () => require('../../routes/products.routes'),
  }),
  Object.freeze({
    routePrefix: '/stock',
    loadRouter: () => require('../../routes/stock.routes'),
  }),
  Object.freeze({
    routePrefix: '/warehouses',
    loadRouter: () => require('../../routes/warehouses.routes'),
  }),
])

module.exports = Object.freeze({
  code: 'inventory',
  dependencies: Object.freeze([]),
  routes,
})
```

- [ ] **Step 4: Verify GREEN before changing route assembly**

Run:

```bash
cd deposito-backend && npm run test:modules
```

Expected: PASS for all module tests. Confirm the existing registry entry remains `{ code: 'inventory', name: 'Inventario', dependencies: [] }`; no new dependency is justified.

- [ ] **Step 5: Mount legacy Inventory routers through the manifest**

In `src/routes/index.js`, import the manifest:

```js
const inventoryModule = require('../modules/inventory/manifest')
```

Replace only the three existing Inventory mounts with:

```js
for (const inventoryRoute of inventoryModule.routes) {
  router.use(
    inventoryRoute.routePrefix,
    requireModule(inventoryModule.code),
    inventoryRoute.loadRouter()
  )
}
```

Leave `router.use(resolveTenant)` above this loop. Do not edit `products.routes.js`, `stock.routes.js`, or `warehouses.routes.js`; their `Auth` and `hasPermission` middleware remain authoritative for permissions.

- [ ] **Step 6: Re-run backend checks**

Run:

```bash
cd deposito-backend && npm run test:modules
cd deposito-backend && npx prisma validate
```

Expected: both commands exit 0. Prisma may load the existing environment, but no environment file may be written or staged.

- [ ] **Step 7: Commit the backend implementation**

Review first:

```bash
cd deposito-backend && git diff --check && git status --short
```

Stage only implementation and test files, then commit:

```bash
cd deposito-backend && git add docs/superpowers/plans/2026-09-11-inventory-products.md src/modules/inventory/manifest.js src/routes/index.js tests/modules.registry.test.js && git commit -m "feat(inventory): expose legacy routes through module manifest"
```

---

### Task 2: Load Inventory pages through the frontend manifest

**Files:**

- Create: `src/modules/inventory/manifest.ts`
- Modify: `src/App.tsx`
- Modify: `src/config/appModules.ts`

**Interfaces:**

- Consumes: existing default exports for Product Management, product detail/create, import, deleted products, lots, and stock movements.
- Produces: `inventoryModule` with `{ code, dependencies, paths, routePrefixes, pages }` and only lazy-loaded page references.

- [ ] **Step 1: Create the minimal frontend manifest**

Create `src/modules/inventory/manifest.ts`:

```ts
import { lazy } from 'react'

export const inventoryModule = {
  code: 'inventory',
  dependencies: [] as const,
  paths: {
    list: '/inventario',
    legacyList: '/productos',
    create: '/inventario/nuevo',
    lots: '/inventario/lotes',
    movements: '/inventario/movimientos',
    deleted: '/inventario/eliminados',
    detail: '/inventario/:id',
    import: '/inventario/importar',
  },
  routePrefixes: ['/productos', '/scanner'] as const,
  pages: {
    Management: lazy(() => import('@/components/ProductManagement')),
    Create: lazy(() => import('@/components/products/ProductCreatePage')),
    Detail: lazy(() => import('@/components/products/ProductDetailPage')),
    Import: lazy(() => import('@/pages/ImportPage')),
    Deleted: lazy(() => import('@/pages/DeletedProductsPage')),
    Lots: lazy(() => import('@/pages/LotsExpiryPage')),
    Movements: lazy(() => import('@/components/stock/StockMovesPage')),
  },
} as const
```

This is declarative wiring only. No test framework is added; TypeScript compilation and Vite chunk generation are its runnable checks.

- [ ] **Step 2: Make `App.tsx` consume only the manifest entry point**

Import the manifest:

```ts
import { inventoryModule } from '@/modules/inventory/manifest'
```

Delete the seven direct lazy declarations now owned by the manifest and replace them with:

```ts
const ProductManagement = inventoryModule.pages.Management
const ProductCreatePage = inventoryModule.pages.Create
const ProductDetailPage = inventoryModule.pages.Detail
const ImportPage = inventoryModule.pages.Import
const DeletedProductsPage = inventoryModule.pages.Deleted
const LotsExpiryPage = inventoryModule.pages.Lots
const StockMovesPage = inventoryModule.pages.Movements
```

Use `inventoryModule.paths` for the eight Inventory/Product `<Route path>` values. Do not change permission arrays or the routes for `inventory-count` and `merchandise`.

- [ ] **Step 3: Reuse the manifest aliases in module configuration**

In `src/config/appModules.ts`, import `inventoryModule` and change only the Inventory card:

```ts
routePrefixes: [...inventoryModule.routePrefixes]
```

Keep `permissions: ['products.view']`. The commercial boundary continues to run outside `PermissionRoute`, preserving activation/permission separation.

- [ ] **Step 4: Build frontend and inspect chunking**

Run:

```bash
cd deposito-frontend && npm run build
```

Expected: exit 0, with Inventory pages emitted as lazy chunks rather than imported into the initial application chunk.

- [ ] **Step 5: Commit the frontend implementation**

Review first:

```bash
cd deposito-frontend && git diff --check && git status --short
```

Stage only the three implementation files, then commit:

```bash
cd deposito-frontend && git add src/modules/inventory/manifest.ts src/App.tsx src/config/appModules.ts && git commit -m "feat(inventory): load product pages through module manifest"
```

---

### Task 3: Final cross-repository verification

**Files:**

- Verify only; no expected file changes.

**Interfaces:**

- Consumes: both `inventoryModule` manifests and the `inventory` registry definition.
- Produces: verification evidence and clean, documented commits in both repositories.

- [ ] **Step 1: Run all required commands fresh**

Run:

```bash
cd deposito-frontend && npm run build
cd deposito-backend && npm run test:modules
cd deposito-backend && npx prisma validate
```

Expected: all commands exit 0 and the module suite reports zero failures.

- [ ] **Step 2: Audit scope and secrets**

Run in each repository:

```bash
git status --short
git diff HEAD^ --check
git show --stat --oneline HEAD
git show --name-only --format= HEAD | rg '(^|/)\.env($|\.)'
```

Expected: no uncommitted implementation changes, no whitespace errors, only scoped files in each implementation commit, and no `.env` output.

- [ ] **Step 3: Confirm preserved boundaries**

Inspect the final diff and verify:

- `resolveTenant` remains before Inventory mounts.
- Every Inventory mount uses `requireModule(inventoryModule.code)`.
- `Auth` and every `hasPermission` call remain unchanged in the legacy routers.
- `/products`, `/stock`, `/warehouses`, and frontend URL strings resolve to the same contracts as before.
- `inventory-count` and `merchandise` mounts remain independent.
- No legacy implementation file was deleted.

- [ ] **Step 4: Record final commit IDs**

Run:

```bash
cd deposito-frontend && git log -1 --oneline
cd deposito-backend && git log -2 --oneline
```

Report the frontend implementation commit, backend implementation commit, backend design-spec commit, and exact verification results.
