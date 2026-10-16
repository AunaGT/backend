BEGIN;
DO $probe$
DECLARE
  a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); branch uuid:=gen_random_uuid();
  category integer; state integer; draft integer; completed integer; role integer;
  product uuid:=gen_random_uuid(); sale uuid:=gen_random_uuid(); method integer;
  item record;
  actor uuid:=gen_random_uuid(); qa_customer uuid:=gen_random_uuid(); other_customer uuid:=gen_random_uuid();
  engagement uuid:=gen_random_uuid(); receipt uuid:=gen_random_uuid(); commitment uuid:=gen_random_uuid();
BEGIN
  INSERT INTO companies(id,name,code,updated_at) VALUES(a,'QA baseline A','QA-A',now()),(b,'QA baseline B','QA-B',now());
  INSERT INTO branches(id,company_id,name,code,updated_at) VALUES(branch,a,'QA','QA',now());
  INSERT INTO product_categories(name,company_id) VALUES('QA',a) RETURNING id INTO category;
  INSERT INTO stock_statuses(name) VALUES('QA') RETURNING id INTO state;
  SELECT id INTO draft FROM sale_statuses WHERE name='Borrador';
  IF draft IS NULL THEN RAISE EXCEPTION 'Missing bootstrap Borrador'; END IF;
  INSERT INTO sale_statuses(name) VALUES('Completada') RETURNING id INTO completed;
  INSERT INTO roles(name,company_id) VALUES('  QA Local  ',a) RETURNING id INTO role;
  IF (SELECT name_key FROM roles WHERE id=role)<>'qa local' THEN RAISE EXCEPTION 'Generated role name failed'; END IF;
  UPDATE roles SET name=' QA Updated ' WHERE id=role;
  IF (SELECT name_key FROM roles WHERE id=role)<>'qa updated' THEN RAISE EXCEPTION 'Generated role update failed'; END IF;
  BEGIN
    INSERT INTO roles(name,company_id) VALUES('admin',a);
    RAISE EXCEPTION 'Reserved administrator accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO products(id,company_id,name,category_id,status_id,price,cost,kind,tracks_expiry,service_unit_label)
    VALUES(product,a,'QA service',category,state,100,0,'SERVICE',false,'sesión');
  BEGIN
    INSERT INTO products(id,company_id,name,category_id,status_id,price,cost,kind) VALUES(gen_random_uuid(),a,'QA good',category,state,10,5,'STANDARD');
    RAISE EXCEPTION 'Good without supplier accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO sales(id,total,items,status_id,adjusted_total,branch_id) VALUES(sale,100,1,draft,100,branch);
  INSERT INTO sale_items(sale_id,product_id,price,qty) VALUES(sale,product,100,1) RETURNING * INTO item;
  IF item.item_name<>'QA service' OR item.unit_label<>'sesión' OR item.item_kind<>'SERVICE' THEN RAISE EXCEPTION 'Snapshot trigger failed'; END IF;
  BEGIN
    INSERT INTO sale_items(sale_id,product_id,price,qty,item_kind) VALUES(sale,product,100,1,'STANDARD');
    RAISE EXCEPTION 'Wrong commercial kind accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='Wrong commercial kind accepted' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO sale_items(sale_id,product_id,price,qty) VALUES(sale,product,100,1.5);
    RAISE EXCEPTION 'Fractional quantity accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO payment_methods(company_id,name,is_credit,settlement_kind) VALUES(b,'QA bank',false,'BANK') RETURNING id INTO method;
  BEGIN
    INSERT INTO company_payment_methods(company_id,payment_method_id) VALUES(a,method);
    RAISE EXCEPTION 'Foreign company method accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO payment_methods(company_id,name,is_credit,settlement_kind) VALUES(a,'QA bank',false,'BANK');
  BEGIN
    INSERT INTO payment_methods(company_id,name,is_credit,settlement_kind) VALUES(a,' qa BANK ',false,'BANK');
    RAISE EXCEPTION 'Normalized duplicate accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE sales SET status_id=completed WHERE id=sale;
    RAISE EXCEPTION 'Completed POS with null method accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE sales SET status_id=completed,settlement_source='ENGAGEMENT_RECEIPTS' WHERE id=sale;
    RAISE EXCEPTION 'Uncovered Agenda exception accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO users(id,name,email,password,role_id,updated_at) VALUES(actor,'QA',actor::text||'@qa.invalid',gen_random_uuid()::text,role,now());
  INSERT INTO suppliers(id,company_id,name,contact,party_type) VALUES(qa_customer,a,'QA client','QA','CUSTOMER'),(other_customer,a,'QA other client','QA','CUSTOMER');
  INSERT INTO appointment_engagements(id,company_id,branch_id,customer_id,source,currency_code,agreed_total,commercial_snapshot,created_by,updated_at)
    VALUES(engagement,a,branch,qa_customer,'DIRECT','GTQ',100,'{}',actor,now());
  UPDATE sales SET customer_contact_id=qa_customer,origin_engagement_id=engagement,settlement_source='ENGAGEMENT_RECEIPTS' WHERE id=sale;
  INSERT INTO customer_payments(id,branch_id,customer_id,amount,registered_by) VALUES(receipt,branch,qa_customer,100,actor);
  INSERT INTO payment_commitments(id,company_id,branch_id,customer_id,engagement_id,payment_id,amount)
    VALUES(commitment,a,branch,qa_customer,engagement,receipt,50);
  BEGIN
    UPDATE sales SET status_id=completed WHERE id=sale;
    RAISE EXCEPTION 'Partially covered Agenda sale accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE payment_commitments SET amount=100 WHERE id=commitment;
  UPDATE sales SET status_id=completed WHERE id=sale;
  BEGIN
    UPDATE sales SET customer_contact_id=other_customer WHERE id=sale;
    RAISE EXCEPTION 'Covered Agenda sale for another client accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE payment_commitments SET state='RELEASED' WHERE id=commitment;
  BEGIN
    UPDATE sales SET total=100 WHERE id=sale;
    RAISE EXCEPTION 'Released commitment still covered Agenda sale';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $probe$;
ROLLBACK;
