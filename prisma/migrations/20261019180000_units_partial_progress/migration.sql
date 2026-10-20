BEGIN;

-- V2 partials use base accumulators; commercial counters are display ratios.
-- A three-unit delivery of a box of seven is 3 base, displayed as 0.428571 boxes.
ALTER TABLE public.commercial_document_lines DROP CONSTRAINT commercial_line_progress_check;
ALTER TABLE public.commercial_document_lines ADD CONSTRAINT commercial_line_progress_check CHECK (
  qty_invoiced >= 0 AND qty_fulfilled >= 0
  AND qty_invoiced <= qty AND qty_fulfilled <= qty
  AND (
    unit_metadata_version = 2
    OR (qty_fulfilled = trunc(qty_fulfilled, quantity_decimals)
        AND qty_invoiced = trunc(qty_invoiced, quantity_decimals))
  )
);

COMMIT;
