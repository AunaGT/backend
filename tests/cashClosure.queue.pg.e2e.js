const test = require('node:test'), assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { PrismaClient, Prisma } = require('@prisma/client')
const { withMocks } = require('./helpers/reportHarness.cjs')
const qaUrl = process.env.AUNA_CASH_QA_URL

test('classified cash postings cannot be starved by more than a batch of bank-only closures', { skip: !qaUrl }, async () => {
  const destination = new URL(qaUrl)
  assert.equal(destination.hostname, '127.0.0.1'); assert.equal(destination.pathname, '/auna_cash_qa')
  const schema = `cash_queue_${process.pid}_${Date.now()}`
  destination.searchParams.set('schema', schema)
  const setup = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', qaUrl], { encoding: 'utf8', input: `
    CREATE SCHEMA "${schema}";
    SET search_path TO "${schema}";
    CREATE TYPE "JournalSourceType" AS ENUM ('CASH_CLOSURE');
    CREATE TABLE branches (id uuid PRIMARY KEY, company_id uuid NOT NULL);
    CREATE TABLE cash_closures (id uuid PRIMARY KEY, branch_id uuid NOT NULL, closure_number int NOT NULL, date timestamp NOT NULL, status text NOT NULL);
    CREATE TABLE payment_methods (id int PRIMARY KEY, settlement_kind text);
    CREATE TABLE cash_closure_payments (id int PRIMARY KEY, cash_closure_id uuid NOT NULL, payment_method_id int NOT NULL, actual_amount numeric(12,2), theoretical_amount numeric(12,2));
    CREATE TABLE journal_entries (company_id uuid NOT NULL, source_type "JournalSourceType" NOT NULL, source_id text NOT NULL, UNIQUE(company_id,source_type,source_id));
    INSERT INTO branches VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111');
    INSERT INTO payment_methods VALUES (1,'CASH'),(2,'BANK');
    INSERT INTO cash_closures SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'22222222-2222-4222-8222-222222222222',i,'2026-10-20'::timestamp+i*interval '1 minute','Aprobado' FROM generate_series(1,501) i;
    INSERT INTO cash_closure_payments SELECT i,('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,2,75,80 FROM generate_series(1,501) i;
    INSERT INTO cash_closures VALUES ('00000000-0000-4000-8000-000000009999','22222222-2222-4222-8222-222222222222',9999,'2026-10-21','Aprobado');
    INSERT INTO cash_closure_payments VALUES (9999,'00000000-0000-4000-8000-000000009999',1,90,100);
  ` })
  assert.equal(setup.status, 0, setup.stderr)
  const real = new PrismaClient({ datasources: { db: { url: destination.href } }, log: [] }), entries = []
  const core = require.resolve('../src/services/accounting/core')
  const db = { companyModule: { findMany: async () => [] },
    $queryRaw: (parts, ...values) => values.includes('CASH_CLOSURE') ? real.$queryRaw(Prisma.sql(parts, ...values)) : [],
    cashClosure: { findMany: args => real.cashClosure.findMany(args) },
  }
  db.$transaction = async work => work(db)
  for (const model of ['sale', 'return', 'incomingMerchandise', 'incomingMerchandisePaymentEntry', 'customerPayment']) db[model] = { findMany: async () => [] }
  try {
    await withMocks({ [core]: { ...require(core), getDefaultAccounts: async () => ({}), getTaxConfig: async () => ({ regime: 'PEQUENO', ivaRate: 0, pequenoRate: 0 }), getCashClosureAccounts: async () => ({ cash: { id: 'CASH' }, cashOverShort: { id: 'DIFF' } }), createEntry: async (_tx, entry) => {
      await real.$executeRaw`INSERT INTO journal_entries (company_id,source_type,source_id) VALUES (${entry.company_id}::uuid,${entry.source_type}::"JournalSourceType",${entry.source_id})`
      entries.push(entry)
    } } }, require.resolve('../src/services/accounting/postingEngine'), async api => {
      await api.postPendingOperations(db, 'U', '11111111-1111-4111-8111-111111111111')
      assert.equal(entries.length, 1)
      assert.equal(entries[0].source_id, '00000000-0000-4000-8000-000000009999')
      await api.postPendingOperations(db, 'U', '11111111-1111-4111-8111-111111111111')
      assert.equal(entries.length, 1)
    })
  } finally { await real.$disconnect() }
})
