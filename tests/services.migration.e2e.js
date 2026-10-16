const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { servicesTestDatabaseUrl } = require('./helpers/servicesTestDb.cjs')

const migrations = ['202610100001_catalog_service_kind', '202610100002_service_commercial_quantities']
function sql(url, schema, input) {
  const result = spawnSync('psql', [url, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
    input: `SET search_path TO "${schema}";\n${input}`, encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

function fixture(url, schema, quantity = 2) {
  sql(url, schema, `CREATE SCHEMA "${schema}";
    CREATE TYPE "ProductKind" AS ENUM ('STANDARD','KIT');
    CREATE TABLE products (id text PRIMARY KEY, name varchar(150), kind "ProductKind" NOT NULL,
      supplier_id text NOT NULL, stock integer NOT NULL, min_stock integer NOT NULL,
      cost numeric(12,2) NOT NULL, tracks_expiry boolean NOT NULL, stock_assembled boolean NOT NULL);
    INSERT INTO products VALUES ('b','Bien','STANDARD','p',10,1,5,false,false);
    CREATE TABLE sale_items (id integer PRIMARY KEY, product_id text NOT NULL REFERENCES products(id), qty integer NOT NULL, net_total numeric(12,2));
    INSERT INTO sale_items VALUES (1,'b',${quantity},10);
    CREATE TABLE commercial_document_lines (id text PRIMARY KEY, product_id text NOT NULL REFERENCES products(id), qty integer NOT NULL, qty_fulfilled integer NOT NULL DEFAULT 0, qty_invoiced integer NOT NULL DEFAULT 0);
    INSERT INTO commercial_document_lines VALUES ('l','b',2,1,0);
    CREATE TABLE order_delivery_lines (id integer, qty integer NOT NULL, qty_invoiced integer NOT NULL DEFAULT 0);
    INSERT INTO order_delivery_lines VALUES (1,1,0);
    CREATE TABLE return_items (id integer, qty_returned integer NOT NULL, received_qty integer, restock_qty integer);
    INSERT INTO return_items VALUES (1,1,1,1);
    CREATE TABLE return_replacement_items (id integer, product_id text NOT NULL REFERENCES products(id), qty integer NOT NULL);
    INSERT INTO return_replacement_items VALUES (1,'b',1);
    CREATE TABLE product_stocks (stock integer);
    INSERT INTO product_stocks VALUES (10);`)
}

test('migration preserves integer quantities, net totals and physical columns, then accepts service fractions', { skip: !process.env.AUNA_SERVICES_TEST_DATABASE_URL && process.env.AUNA_SERVICES_STAGING_TESTS !== 'approved' }, () => {
  const url = servicesTestDatabaseUrl()
  const schema = 'services_' + randomUUID().replaceAll('-', '')
  fixture(url, schema)
  try {
    const before = sql(url, schema, 'SELECT qty, net_total FROM sale_items; SELECT stock FROM product_stocks;')
    for (const migration of migrations) sql(url, schema, fs.readFileSync(require('../scripts/migrationFiles').migrationSqlPath(migration,{historical:true}), 'utf8'))
    assert.equal(sql(url, schema, 'SELECT qty::integer, net_total FROM sale_items; SELECT stock FROM product_stocks;'), before)
    assert.equal(sql(url, schema, 'SELECT item_name, item_kind, unit_label, quantity_decimals FROM sale_items;'), 'Bien|STANDARD|unidad|0')
    sql(url, schema, `INSERT INTO products (id,name,kind,supplier_id,stock,min_stock,cost,tracks_expiry,stock_assembled,service_unit_label,quantity_decimals)
      VALUES ('s','Asesoría','SERVICE',NULL,0,0,0,false,false,'Hora',2);
      INSERT INTO sale_items (id,product_id,qty,net_total,item_name,item_kind,unit_label,quantity_decimals) VALUES (2,'s',1.5,150,'Asesoría','SERVICE','Hora',2);`)
    assert.equal(sql(url, schema, "SELECT qty::text FROM sale_items WHERE id=2;"), '1.5000')
    assert.equal(sql(url, schema, "SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='return_items' AND column_name='restock_qty';"), 'integer')
    assert.throws(() => sql(url, schema, "UPDATE products SET stock=1 WHERE id='s';"), /constraint/i)
    assert.throws(() => sql(url, schema, "UPDATE sale_items SET qty=1.5 WHERE id=1;"), /constraint/i)
  } finally { sql(url, schema, `DROP SCHEMA "${schema}" CASCADE;`) }
})

test('preflight aborts out-of-range legacy quantities instead of truncating them', { skip: !process.env.AUNA_SERVICES_TEST_DATABASE_URL && process.env.AUNA_SERVICES_STAGING_TESTS !== 'approved' }, () => {
  const url = servicesTestDatabaseUrl()
  const schema = 'services_' + randomUUID().replaceAll('-', '')
  fixture(url, schema, 100000000)
  try {
    sql(url, schema, fs.readFileSync(require('../scripts/migrationFiles').migrationSqlPath(migrations[0],{historical:true}), 'utf8'))
    assert.throws(() => sql(url, schema, fs.readFileSync(require('../scripts/migrationFiles').migrationSqlPath(migrations[1],{historical:true}), 'utf8')), /rango/i)
    assert.equal(sql(url, schema, 'SELECT qty FROM sale_items;'), '100000000')
  } finally { sql(url, schema, `DROP SCHEMA "${schema}" CASCADE;`) }
})

test('legacy zero-quantity records are preserved but new zero-quantity lines are rejected', { skip: !process.env.AUNA_SERVICES_TEST_DATABASE_URL && process.env.AUNA_SERVICES_STAGING_TESTS !== 'approved' }, () => {
  const url=servicesTestDatabaseUrl()
  const schema='services_'+randomUUID().replaceAll('-','')
  fixture(url,schema,0)
  try {
    for(const migration of migrations)sql(url,schema,fs.readFileSync(require('../scripts/migrationFiles').migrationSqlPath(migration,{historical:true}),'utf8'))
    assert.equal(sql(url,schema,'SELECT qty::text FROM sale_items;'),'0.0000')
    assert.throws(()=>sql(url,schema,"INSERT INTO sale_items (id,product_id,qty,net_total) VALUES (3,'b',0,0);"),/constraint/i)
  } finally {sql(url,schema,`DROP SCHEMA "${schema}" CASCADE;`)}
})
