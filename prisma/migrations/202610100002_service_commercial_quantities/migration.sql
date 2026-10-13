BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
DECLARE item text[]; invalid boolean;
BEGIN
  FOREACH item SLICE 1 IN ARRAY ARRAY[
    ['sale_items','qty'],['commercial_document_lines','qty'],
    ['commercial_document_lines','qty_fulfilled'],['commercial_document_lines','qty_invoiced'],
    ['order_delivery_lines','qty'],['order_delivery_lines','qty_invoiced'],
    ['return_items','qty_returned'],['return_replacement_items','qty']
  ] LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE %I < 0 OR %I > 99999999.9999)', item[1],item[2],item[2]) INTO invalid;
    IF invalid THEN RAISE EXCEPTION 'Cantidad legacy fuera de rango en %.%',item[1],item[2]; END IF;
  END LOOP;
END $$;

ALTER TABLE products ALTER COLUMN supplier_id DROP NOT NULL,
  ADD COLUMN service_unit_label varchar(50), ADD COLUMN quantity_decimals integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT products_service_fields_check CHECK (
    quantity_decimals BETWEEN 0 AND 4 AND
    (CASE WHEN kind='SERVICE' THEN supplier_id IS NULL AND stock=0 AND min_stock=0 AND cost=0
      AND NOT tracks_expiry AND NOT stock_assembled AND service_unit_label IS NOT NULL
      AND length(trim(service_unit_label)) BETWEEN 1 AND 50
    ELSE supplier_id IS NOT NULL AND quantity_decimals=0 AND service_unit_label IS NULL END)
  );

ALTER TABLE sale_items ALTER COLUMN qty TYPE numeric(12,4) USING qty::numeric(12,4);
ALTER TABLE commercial_document_lines
  ALTER COLUMN qty TYPE numeric(12,4) USING qty::numeric(12,4),
  ALTER COLUMN qty_fulfilled TYPE numeric(12,4) USING qty_fulfilled::numeric(12,4),
  ALTER COLUMN qty_invoiced TYPE numeric(12,4) USING qty_invoiced::numeric(12,4);
ALTER TABLE order_delivery_lines
  ALTER COLUMN qty TYPE numeric(12,4) USING qty::numeric(12,4),
  ALTER COLUMN qty_invoiced TYPE numeric(12,4) USING qty_invoiced::numeric(12,4);
ALTER TABLE return_items ALTER COLUMN qty_returned TYPE numeric(12,4) USING qty_returned::numeric(12,4);
ALTER TABLE return_replacement_items ALTER COLUMN qty TYPE numeric(12,4) USING qty::numeric(12,4);

DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['sale_items','commercial_document_lines','return_replacement_items'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN item_name varchar(150), ADD COLUMN item_kind "ProductKind", ADD COLUMN unit_label varchar(50), ADD COLUMN quantity_decimals integer NOT NULL DEFAULT 0',target);
    EXECUTE format('UPDATE %I l SET item_name=p.name,item_kind=p.kind,unit_label=''unidad'',quantity_decimals=0 FROM products p WHERE p.id=l.product_id',target);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN item_name SET NOT NULL, ALTER COLUMN item_kind SET NOT NULL, ALTER COLUMN unit_label SET NOT NULL,
      ADD CONSTRAINT %I CHECK (quantity_decimals BETWEEN 0 AND 4 AND (item_kind=''SERVICE'' OR quantity_decimals=0)
      AND qty>0 AND qty=trunc(qty,quantity_decimals) AND length(trim(item_name))>0 AND length(trim(unit_label))>0) NOT VALID',target,target||'_commercial_quantity_check');
  END LOOP;
END $$;

ALTER TABLE commercial_document_lines ADD CONSTRAINT commercial_line_progress_check CHECK (
  qty_invoiced>=0 AND qty_fulfilled>=0 AND qty_invoiced<=qty AND qty_fulfilled<=qty
  AND qty_fulfilled=trunc(qty_fulfilled,quantity_decimals) AND qty_invoiced=trunc(qty_invoiced,quantity_decimals)
);
ALTER TABLE order_delivery_lines ADD CONSTRAINT delivery_quantity_check CHECK (qty>0 AND qty_invoiced>=0 AND qty_invoiced<=qty);
ALTER TABLE return_items ADD CONSTRAINT return_quantity_positive CHECK (qty_returned>0);

-- Preserve snapshots even for an older goods writer during the coordinated deployment.
CREATE FUNCTION capture_commercial_item_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE product_record record;
BEGIN
  SELECT name,kind,service_unit_label,quantity_decimals INTO product_record FROM products WHERE id=NEW.product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Artículo no encontrado para snapshot'; END IF;
  NEW.item_name := COALESCE(NEW.item_name,product_record.name);
  NEW.item_kind := COALESCE(NEW.item_kind,product_record.kind);
  IF (NEW.item_kind='SERVICE') IS DISTINCT FROM (product_record.kind='SERVICE') THEN RAISE EXCEPTION 'Tipo comercial incompatible con artículo'; END IF;
  IF NEW.unit_label IS NULL THEN
    NEW.unit_label := CASE WHEN NEW.item_kind='SERVICE' THEN product_record.service_unit_label ELSE 'unidad' END;
    NEW.quantity_decimals := CASE WHEN NEW.item_kind='SERVICE' THEN product_record.quantity_decimals ELSE 0 END;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['sale_items','commercial_document_lines','return_replacement_items'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION capture_commercial_item_snapshot()',target||'_snapshot',target);
  END LOOP;
END $$;
COMMIT;
