BEGIN;
CREATE SCHEMA IF NOT EXISTS public;
SET LOCAL search_path=public,pg_catalog,extensions;
CREATE TYPE public."AccountType" AS ENUM (
    'ASSET',
    'LIABILITY',
    'EQUITY',
    'INCOME',
    'COST',
    'EXPENSE'
);
CREATE TYPE public."AccountingPeriodStatus" AS ENUM (
    'OPEN',
    'CLOSED'
);
CREATE TYPE public."AdvanceStatus" AS ENUM (
    'PENDIENTE',
    'PAGADO',
    'CANCELADO'
);
CREATE TYPE public."AttendanceStatus" AS ENUM (
    'PRESENTE',
    'TARDE',
    'AUSENTE',
    'VACACIONES',
    'INCAPACIDAD',
    'PERMISO',
    'ASUETO'
);
CREATE TYPE public."CashRegisterSessionStatus" AS ENUM (
    'OPEN',
    'CLOSED',
    'VOID'
);
CREATE TYPE public."CommercialDocStatus" AS ENUM (
    'DRAFT',
    'SENT',
    'ACCEPTED',
    'REJECTED',
    'CONFIRMED',
    'PARTIALLY_FULFILLED',
    'FULFILLED',
    'CANCELLED',
    'EXPIRED'
);
CREATE TYPE public."CommercialDocType" AS ENUM (
    'QUOTE',
    'ORDER'
);
CREATE TYPE public."CompanyModuleStatus" AS ENUM (
    'ACTIVE',
    'TRIAL',
    'SUSPENDED',
    'DISABLED'
);
CREATE TYPE public."ContactEntityKind" AS ENUM (
    'PERSON',
    'ORGANIZATION'
);
CREATE TYPE public."ContractType" AS ENUM (
    'INDEFINIDO',
    'PLAZO_FIJO',
    'POR_OBRA'
);
CREATE TYPE public."CouponAssetStatus" AS ENUM (
    'UPLOADING',
    'READY',
    'DELETING'
);
CREATE TYPE public."CustomerPaymentKind" AS ENUM (
    'PAYMENT',
    'CREDIT_NOTE',
    'WRITE_OFF'
);
CREATE TYPE public."EmployeePaymentMethod" AS ENUM (
    'EFECTIVO',
    'TRANSFERENCIA',
    'CHEQUE'
);
CREATE TYPE public."EmployeeStatus" AS ENUM (
    'ACTIVO',
    'SUSPENDIDO',
    'BAJA'
);
CREATE TYPE public."ExperienceProfile" AS ENUM (
    'CASHIER',
    'MANAGER',
    'OWNER',
    'ADVANCED'
);
CREATE TYPE public."InventoryCountSessionStatus" AS ENUM (
    'DRAFT',
    'IN_PROGRESS',
    'IN_REVIEW',
    'PENDING_SECOND_APPROVAL',
    'APPROVED',
    'CANCELLED'
);
CREATE TYPE public."JournalSourceType" AS ENUM (
    'MANUAL',
    'SALE',
    'RETURN',
    'PURCHASE',
    'PURCHASE_PAYMENT',
    'CLOSING',
    'STOCK_ADJUSTMENT',
    'PAYROLL',
    'PAYROLL_PAYMENT',
    'PAYROLL_ADVANCE',
    'CASH_CLOSURE',
    'SALE_PAYMENT',
    'CUSTOMER_ADVANCE',
    'CUSTOMER_ADVANCE_APPLIED',
    'CUSTOMER_PAYMENT_REFUND'
);
CREATE TYPE public."MerchandisePaymentStatus" AS ENUM (
    'PENDING',
    'PAID',
    'PARTIAL'
);
CREATE TYPE public."MerchandiseSource" AS ENUM (
    'PURCHASE',
    'INITIAL'
);
CREATE TYPE public."PayFrequency" AS ENUM (
    'MENSUAL',
    'QUINCENAL'
);
CREATE TYPE public."PayrollConcept" AS ENUM (
    'SUELDO_ORDINARIO',
    'BONIFICACION_INCENTIVO',
    'HORAS_EXTRA',
    'AGUINALDO',
    'BONO14',
    'OTRO_DEVENGO',
    'IGSS_LABORAL',
    'ISR_RETENIDO',
    'ANTICIPO',
    'OTRA_DEDUCCION',
    'IGSS_PATRONAL',
    'IRTRA',
    'INTECAP',
    'PROVISION_AGUINALDO',
    'PROVISION_BONO14',
    'PROVISION_VACACIONES',
    'PROVISION_INDEMNIZACION'
);
CREATE TYPE public."PayrollStatus" AS ENUM (
    'BORRADOR',
    'CONFIRMADA',
    'PAGADA',
    'ANULADA'
);
CREATE TYPE public."PayrollType" AS ENUM (
    'ORDINARIA',
    'AGUINALDO',
    'BONO14'
);
CREATE TYPE public."PayslipLineType" AS ENUM (
    'DEVENGO',
    'DEDUCCION',
    'COSTO_PATRONAL'
);
CREATE TYPE public."PriceTier" AS ENUM (
    'LIST',
    'WHOLESALE',
    'PROMOTION'
);
CREATE TYPE public."ProductKind" AS ENUM (
    'STANDARD',
    'KIT',
    'SERVICE'
);
CREATE TYPE public."ReturnItemDisposition" AS ENUM (
    'SELLABLE',
    'QUARANTINE',
    'SCRAP'
);
CREATE TYPE public."ReturnResolution" AS ENUM (
    'REFUND_ORIGINAL',
    'REFUND_CASH',
    'REFUND_TRANSFER',
    'CUSTOMER_CREDIT',
    'EXCHANGE'
);
CREATE TYPE public."ReturnSettlementKind" AS ENUM (
    'REFUND',
    'CREDIT_OFFSET',
    'COLLECTION',
    'CUSTOMER_CREDIT'
);
CREATE TYPE public."ReturnType" AS ENUM (
    'REFUND',
    'EXCHANGE'
);
CREATE TYPE public."SalePaymentStatus" AS ENUM (
    'PENDING',
    'PARTIAL',
    'PAID'
);
CREATE TYPE public."SalesChannel" AS ENUM (
    'POS',
    'WHOLESALE',
    'ONLINE'
);
CREATE TYPE public."StockMovementReason" AS ENUM (
    'INITIAL',
    'PURCHASE',
    'SALE',
    'SALE_RETURN',
    'ORDER_FULFILL',
    'TRANSFER_OUT',
    'TRANSFER_IN',
    'TRANSFER_CANCEL',
    'INTERNAL_MOVE',
    'COUNT_ADJUST',
    'MANUAL_ADJUST',
    'KIT_ASSEMBLE',
    'KIT_DISASSEMBLE'
);
CREATE TYPE public."StockReservationKind" AS ENUM (
    'ORDER',
    'QUOTE_SOFT'
);
CREATE TYPE public."StockReservationStatus" AS ENUM (
    'ACTIVE',
    'RELEASED',
    'CONSUMED',
    'EXPIRED'
);
CREATE TYPE public."StockTransferStatus" AS ENUM (
    'EN_TRANSITO',
    'RECIBIDA',
    'CANCELADA'
);
CREATE TYPE public."SupplierPartyType" AS ENUM (
    'SUPPLIER',
    'CUSTOMER'
);
CREATE TYPE public."SupplierPaymentStatus" AS ENUM (
    'POSTED',
    'CANCELLED'
);
CREATE TYPE public."WarehouseKind" AS ENUM (
    'BODEGA',
    'SALA_VENTAS',
    'VITRINA',
    'TRANSITO',
    'OTRO'
);
CREATE FUNCTION public.capture_commercial_item_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
CREATE FUNCTION public.guard_confirmed_sale_payment_method() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.payment_method_id IS NULL AND EXISTS(SELECT 1 FROM sale_statuses WHERE id=NEW.status_id AND name='Completada') THEN
    RAISE EXCEPTION 'Confirmed sales require a payment method' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TABLE public.accounting_periods (
    id integer NOT NULL,
    year integer NOT NULL,
    month integer NOT NULL,
    status public."AccountingPeriodStatus" DEFAULT 'OPEN'::public."AccountingPeriodStatus" NOT NULL,
    closed_at timestamp(3) without time zone,
    closed_by uuid,
    company_id uuid NOT NULL
);
CREATE SEQUENCE public.accounting_periods_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.accounting_periods_id_seq OWNED BY public.accounting_periods.id;
CREATE TABLE public.accounts (
    id integer NOT NULL,
    code character varying(20) NOT NULL,
    name character varying(150) NOT NULL,
    type public."AccountType" NOT NULL,
    parent_id integer,
    is_group boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    system boolean DEFAULT false NOT NULL,
    company_id uuid NOT NULL
);
CREATE SEQUENCE public.accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.accounts_id_seq OWNED BY public.accounts.id;
CREATE TABLE public.alert_priorities (
    id integer NOT NULL,
    name character varying(50) NOT NULL
);
CREATE SEQUENCE public.alert_priorities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.alert_priorities_id_seq OWNED BY public.alert_priorities.id;
CREATE TABLE public.alert_types (
    id integer NOT NULL,
    name character varying(50) NOT NULL
);
CREATE SEQUENCE public.alert_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.alert_types_id_seq OWNED BY public.alert_types.id;
CREATE TABLE public.alerts (
    id uuid NOT NULL,
    type_id integer NOT NULL,
    priority_id integer NOT NULL,
    title character varying(150) NOT NULL,
    message text,
    product_id uuid NOT NULL,
    current_stock integer,
    min_stock integer,
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    status_id integer NOT NULL,
    assigned_to uuid,
    resolved integer DEFAULT 0 NOT NULL,
    branch_id uuid NOT NULL
);
CREATE TABLE public.appointment_bookings (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    session_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    status character varying(20) NOT NULL,
    expires_at timestamp(3) without time zone,
    quantity numeric(12,4) NOT NULL,
    commercial_snapshot jsonb NOT NULL,
    policy_snapshot jsonb NOT NULL,
    notes character varying(2000) DEFAULT ''::character varying NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    session_type character varying(20) DEFAULT 'SCHEDULED_SERVICE'::character varying NOT NULL,
    CONSTRAINT appointment_booking_rules_check CHECK (((quantity > (0)::numeric) AND (version > 0) AND ((status)::text = ANY ((ARRAY['HELD'::character varying, 'PENDING'::character varying, 'CONFIRMED'::character varying, 'ARRIVED'::character varying, 'IN_SERVICE'::character varying, 'COMPLETED'::character varying, 'NO_SHOW'::character varying, 'CANCELLED'::character varying, 'EXPIRED'::character varying])::text[])) AND (((status)::text <> ALL ((ARRAY['HELD'::character varying, 'PENDING'::character varying])::text[])) OR (expires_at IS NOT NULL)))),
    CONSTRAINT appointment_booking_type_check CHECK (((session_type)::text = 'SCHEDULED_SERVICE'::text))
);
CREATE TABLE public.appointment_engagement_history (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    engagement_id uuid NOT NULL,
    actor_id uuid,
    action character varying(30) NOT NULL,
    reason character varying(500) DEFAULT ''::character varying NOT NULL,
    before jsonb,
    after jsonb,
    request_key character varying(64) NOT NULL,
    input_hash character varying(64) NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.appointment_engagement_lines (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    engagement_id uuid NOT NULL,
    source_document_id uuid,
    source_line_id uuid,
    product_id uuid NOT NULL,
    item_kind public."ProductKind" NOT NULL,
    item_name character varying(150) NOT NULL,
    unit_label character varying(50) NOT NULL,
    quantity_decimals integer DEFAULT 0 NOT NULL,
    qty numeric(12,4) NOT NULL,
    unit_price numeric(12,2) NOT NULL,
    line_total numeric(12,2) NOT NULL,
    service_schedule_snapshot jsonb,
    sort_order integer DEFAULT 0 NOT NULL,
    CONSTRAINT engagement_line_rules_check CHECK (((qty > (0)::numeric) AND ((quantity_decimals >= 0) AND (quantity_decimals <= 4)) AND (qty = round(qty, quantity_decimals)) AND (unit_price >= (0)::numeric) AND (line_total >= (0)::numeric) AND ((source_document_id IS NULL) = (source_line_id IS NULL))))
);
CREATE TABLE public.appointment_engagement_schedules (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    engagement_id uuid NOT NULL,
    line_id uuid NOT NULL,
    session_id uuid NOT NULL,
    session_type character varying(20) NOT NULL,
    booking_id uuid,
    kind character varying(10) NOT NULL,
    quantity numeric(12,4) NOT NULL,
    state character varying(15) DEFAULT 'COMMITTED'::character varying NOT NULL,
    conditions_hash character varying(64) NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT engagement_schedule_rules_check CHECK (((quantity > (0)::numeric) AND ((state)::text = ANY ((ARRAY['COMMITTED'::character varying, 'COMPLETED'::character varying, 'SOLD'::character varying, 'CANCELLED'::character varying, 'RELEASED'::character varying])::text[])) AND ((((kind)::text = 'BOOKING'::text) AND (booking_id IS NOT NULL) AND ((session_type)::text = 'SCHEDULED_SERVICE'::text)) OR (((kind)::text = 'SESSION'::text) AND (booking_id IS NULL) AND ((session_type)::text = 'SCHEDULED_SERVICE'::text)) OR (((kind)::text = 'ACTIVITY'::text) AND (booking_id IS NULL) AND ((session_type)::text = 'ACTIVITY'::text)))))
);
CREATE TABLE public.appointment_engagements (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    source character varying(10) NOT NULL,
    quote_id uuid,
    order_id uuid,
    sale_id uuid,
    currency_code character varying(3) NOT NULL,
    agreed_total numeric(12,2) NOT NULL,
    commercial_snapshot jsonb NOT NULL,
    resolution_pending boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    CONSTRAINT engagement_rules_check CHECK ((((source)::text = ANY ((ARRAY['DIRECT'::character varying, 'QUOTE'::character varying])::text[])) AND (((source)::text = 'QUOTE'::text) = (quote_id IS NOT NULL)) AND ((currency_code)::text ~ '^[A-Z]{3}$'::text) AND (agreed_total >= (0)::numeric) AND (version > 0)))
);
CREATE TABLE public.appointment_history (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    session_id uuid,
    booking_id uuid,
    actor_id uuid,
    action character varying(50) NOT NULL,
    before jsonb,
    after jsonb,
    reason character varying(500) DEFAULT ''::character varying NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.appointment_participants (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    session_id uuid NOT NULL,
    session_type character varying(20) DEFAULT 'ACTIVITY'::character varying NOT NULL,
    kind character varying(20) NOT NULL,
    user_id uuid,
    contact_id uuid,
    name character varying(150),
    CONSTRAINT appointment_participant_shape CHECK ((((session_type)::text = 'ACTIVITY'::text) AND ((((kind)::text = 'USER'::text) AND (user_id IS NOT NULL) AND (contact_id IS NULL) AND (name IS NULL)) OR (((kind)::text = 'GUEST'::text) AND (user_id IS NULL) AND (name IS NOT NULL) AND ((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 150))))))
);
CREATE TABLE public.appointment_requests (
    company_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    operation character varying(50) NOT NULL,
    idempotency_key character varying(100) NOT NULL,
    input_hash character varying(64) NOT NULL,
    result_type character varying(20) NOT NULL,
    result_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT appointment_request_result_check CHECK ((((result_type)::text = ANY ((ARRAY['BOOKING'::character varying, 'SESSION'::character varying, 'WAITLIST'::character varying, 'ACTIVITY'::character varying, 'ENGAGEMENT'::character varying, 'PAYMENT'::character varying])::text[])) AND ((input_hash)::text ~ '^[0-9a-f]{64}$'::text)))
);
CREATE TABLE public.appointment_session_providers (
    company_id uuid NOT NULL,
    session_id uuid NOT NULL,
    provider_id uuid NOT NULL
);
CREATE TABLE public.appointment_session_resources (
    company_id uuid NOT NULL,
    session_id uuid NOT NULL,
    resource_id uuid NOT NULL
);
CREATE TABLE public.appointment_sessions (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    product_id uuid,
    mode character varying(20) NOT NULL,
    starts_at timestamp(3) without time zone NOT NULL,
    ends_at timestamp(3) without time zone NOT NULL,
    occupied_from timestamp(3) without time zone NOT NULL,
    occupied_until timestamp(3) without time zone NOT NULL,
    timezone character varying(100) NOT NULL,
    capacity integer NOT NULL,
    status character varying(20) DEFAULT 'SCHEDULED'::character varying NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    policy_snapshot jsonb NOT NULL,
    notes character varying(2000) DEFAULT ''::character varying NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    record_type character varying(20) DEFAULT 'SCHEDULED_SERVICE'::character varying NOT NULL,
    purpose character varying(20),
    title character varying(200),
    organizer_id uuid,
    venue jsonb DEFAULT '{"url": "", "kind": "BRANCH", "name": "", "address": "", "references": ""}'::jsonb NOT NULL,
    estimated_attendance integer,
    outbound_minutes integer DEFAULT 0 NOT NULL,
    setup_minutes integer DEFAULT 0 NOT NULL,
    teardown_minutes integer DEFAULT 0 NOT NULL,
    return_minutes integer DEFAULT 0 NOT NULL,
    actual_completed_at timestamp(3) without time zone,
    commercial_completion_confirmed_at timestamp(3) without time zone,
    completion_policy character varying(10) DEFAULT 'MANUAL'::character varying NOT NULL,
    CONSTRAINT appointment_completion_policy_check CHECK (((completion_policy)::text = ANY ((ARRAY['MANUAL'::character varying, 'AUTO'::character varying])::text[]))),
    CONSTRAINT appointment_margins_check CHECK ((((outbound_minutes >= 0) AND (outbound_minutes <= 1440)) AND ((setup_minutes >= 0) AND (setup_minutes <= 1440)) AND ((teardown_minutes >= 0) AND (teardown_minutes <= 1440)) AND ((return_minutes >= 0) AND (return_minutes <= 1440)) AND ((estimated_attendance IS NULL) OR ((estimated_attendance >= 1) AND (estimated_attendance <= 1000000))))),
    CONSTRAINT appointment_record_shape CHECK (((((record_type)::text = 'SCHEDULED_SERVICE'::text) AND (product_id IS NOT NULL)) OR (((record_type)::text = 'ACTIVITY'::text) AND (organizer_id IS NOT NULL) AND (title IS NOT NULL) AND ((length(TRIM(BOTH FROM title)) >= 1) AND (length(TRIM(BOTH FROM title)) <= 200)) AND (purpose IS NOT NULL) AND ((purpose)::text = ANY ((ARRAY['MEETING'::character varying, 'SERVICE_VISIT'::character varying, 'EVENT'::character varying])::text[])) AND ((mode)::text = 'INDIVIDUAL'::text) AND (capacity = 1) AND ((ends_at - starts_at) <= '31 days'::interval) AND (occupied_from = (starts_at - (((outbound_minutes + setup_minutes))::double precision * '00:01:00'::interval))) AND (occupied_until = (ends_at + (((teardown_minutes + return_minutes))::double precision * '00:01:00'::interval)))))),
    CONSTRAINT appointment_session_rules_check CHECK ((((mode)::text = ANY ((ARRAY['INDIVIDUAL'::character varying, 'GROUP'::character varying])::text[])) AND ((capacity >= 1) AND (capacity <= 10000)) AND (((mode)::text <> 'INDIVIDUAL'::text) OR (capacity = 1)) AND (version > 0) AND ((status)::text = ANY ((ARRAY['SCHEDULED'::character varying, 'IN_PROGRESS'::character varying, 'COMPLETED'::character varying, 'CANCELLED'::character varying])::text[])) AND (occupied_from <= starts_at) AND (starts_at < ends_at) AND (ends_at <= occupied_until)))
);
CREATE TABLE public.appointment_waitlist (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    session_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    status character varying(20) DEFAULT 'WAITING'::character varying NOT NULL,
    booking_id uuid,
    created_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    session_type character varying(20) DEFAULT 'SCHEDULED_SERVICE'::character varying NOT NULL,
    CONSTRAINT appointment_waitlist_state_check CHECK ((((status)::text = ANY ((ARRAY['WAITING'::character varying, 'ADMITTED'::character varying, 'WITHDRAWN'::character varying])::text[])) AND (((status)::text <> 'ADMITTED'::text) OR (booking_id IS NOT NULL)))),
    CONSTRAINT appointment_waitlist_type_check CHECK (((session_type)::text = 'SCHEDULED_SERVICE'::text))
);
CREATE TABLE public.attendance (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    work_date date NOT NULL,
    check_in character varying(5),
    check_out character varying(5),
    hours numeric(5,2),
    overtime_hours numeric(5,2) DEFAULT 0 NOT NULL,
    status public."AttendanceStatus" DEFAULT 'PRESENTE'::public."AttendanceStatus" NOT NULL,
    notes text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);
CREATE TABLE public.availability_exceptions (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    calendar_id uuid NOT NULL,
    local_date date NOT NULL,
    from_minute integer,
    to_minute integer,
    reason character varying(500) DEFAULT ''::character varying NOT NULL,
    CONSTRAINT availability_exception_interval_check CHECK ((((from_minute IS NULL) AND (to_minute IS NULL)) OR ((from_minute IS NOT NULL) AND (to_minute IS NOT NULL) AND ((from_minute >= 0) AND (from_minute <= 1439)) AND ((to_minute >= 1) AND (to_minute <= 1440)) AND (from_minute < to_minute))))
);
CREATE TABLE public.availability_rules (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    calendar_id uuid NOT NULL,
    weekday integer NOT NULL,
    from_minute integer NOT NULL,
    to_minute integer NOT NULL,
    CONSTRAINT availability_rule_interval_check CHECK ((((weekday >= 1) AND (weekday <= 7)) AND ((from_minute >= 0) AND (from_minute <= 1439)) AND ((to_minute >= 1) AND (to_minute <= 1440)) AND (from_minute < to_minute)))
);
CREATE TABLE public.barcode_print_preparations (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    request_key uuid NOT NULL,
    request_hash character varying(64) NOT NULL,
    snapshot jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.branches (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    name character varying(150) NOT NULL,
    code character varying(10) NOT NULL,
    seq integer NOT NULL,
    address text,
    phone character varying(50),
    active boolean DEFAULT true NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    sales_location_id uuid,
    operational_status character varying(20) DEFAULT 'OPERATING'::character varying NOT NULL,
    manager_user_id uuid
);
CREATE SEQUENCE public.branches_seq_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.branches_seq_seq OWNED BY public.branches.seq;
CREATE TABLE public.cash_closure_denominations (
    id integer NOT NULL,
    cash_closure_id uuid NOT NULL,
    denomination numeric(10,2) NOT NULL,
    type character varying(20) NOT NULL,
    quantity integer NOT NULL,
    subtotal numeric(12,2) NOT NULL
);
CREATE SEQUENCE public.cash_closure_denominations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.cash_closure_denominations_id_seq OWNED BY public.cash_closure_denominations.id;
CREATE TABLE public.cash_closure_payments (
    id integer NOT NULL,
    cash_closure_id uuid NOT NULL,
    payment_method_id integer NOT NULL,
    theoretical_amount numeric(12,2) NOT NULL,
    theoretical_count integer NOT NULL,
    actual_amount numeric(12,2) NOT NULL,
    actual_count integer,
    difference numeric(12,2) NOT NULL,
    notes text
);
CREATE SEQUENCE public.cash_closure_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.cash_closure_payments_id_seq OWNED BY public.cash_closure_payments.id;
CREATE TABLE public.cash_closures (
    id uuid NOT NULL,
    closure_number integer NOT NULL,
    date timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    start_date timestamp(3) without time zone NOT NULL,
    end_date timestamp(3) without time zone NOT NULL,
    cashier_name character varying(100) NOT NULL,
    cashier_signature text,
    supervisor_name character varying(100),
    supervisor_signature text,
    supervisor_validated_at timestamp(3) without time zone,
    theoretical_total numeric(12,2) NOT NULL,
    theoretical_sales numeric(12,2) NOT NULL,
    theoretical_returns numeric(12,2) NOT NULL,
    actual_total numeric(12,2) NOT NULL,
    difference numeric(12,2) NOT NULL,
    difference_percentage numeric(5,2),
    total_transactions integer NOT NULL,
    total_customers integer NOT NULL,
    average_ticket numeric(12,2) NOT NULL,
    notes text,
    status character varying(50) DEFAULT 'Pendiente'::character varying NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    cashier_id uuid,
    supervisor_id uuid,
    opening_float numeric(12,2),
    branch_id uuid NOT NULL
);
CREATE SEQUENCE public.cash_closures_closure_number_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.cash_closures_closure_number_seq OWNED BY public.cash_closures.closure_number;
CREATE TABLE public.cash_register_sessions (
    id uuid NOT NULL,
    cash_register_id uuid NOT NULL,
    status public."CashRegisterSessionStatus" DEFAULT 'OPEN'::public."CashRegisterSessionStatus" NOT NULL,
    opened_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    closed_at timestamp(3) without time zone,
    opened_by_id uuid NOT NULL,
    closed_by_id uuid,
    opening_float numeric(12,2) NOT NULL,
    notes text,
    cash_closure_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);
CREATE TABLE public.cash_registers (
    id uuid NOT NULL,
    name character varying(120) NOT NULL,
    code character varying(40) NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    branch_id uuid NOT NULL
);
CREATE TABLE public.commercial_document_lines (
    id uuid NOT NULL,
    document_id uuid NOT NULL,
    product_id uuid NOT NULL,
    qty numeric(12,4) NOT NULL,
    unit_price numeric(12,2) NOT NULL,
    line_total numeric(12,2) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    qty_fulfilled numeric(12,4) DEFAULT 0 NOT NULL,
    qty_invoiced numeric(12,4) DEFAULT 0 NOT NULL,
    item_name character varying(150) NOT NULL,
    item_kind public."ProductKind" NOT NULL,
    unit_label character varying(50) NOT NULL,
    quantity_decimals integer DEFAULT 0 NOT NULL,
    service_schedule_snapshot jsonb,
    CONSTRAINT commercial_line_progress_check CHECK (((qty_invoiced >= (0)::numeric) AND (qty_fulfilled >= (0)::numeric) AND (qty_invoiced <= qty) AND (qty_fulfilled <= qty) AND (qty_fulfilled = trunc(qty_fulfilled, quantity_decimals)) AND (qty_invoiced = trunc(qty_invoiced, quantity_decimals)))),
    CONSTRAINT order_line_invoiced_bounds CHECK (((qty_invoiced >= (0)::numeric) AND (qty_invoiced <= qty)))
);
CREATE TABLE public.commercial_document_sales (
    id uuid NOT NULL,
    document_id uuid NOT NULL,
    sale_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.commercial_documents (
    id uuid NOT NULL,
    reference character varying(30),
    doc_type public."CommercialDocType" NOT NULL,
    status public."CommercialDocStatus" DEFAULT 'DRAFT'::public."CommercialDocStatus" NOT NULL,
    valid_until timestamp(3) without time zone,
    customer character varying(150),
    customer_nit character varying(50),
    is_final_consumer boolean DEFAULT true NOT NULL,
    customer_contact_id uuid,
    sales_channel public."SalesChannel" DEFAULT 'WHOLESALE'::public."SalesChannel" NOT NULL,
    subtotal numeric(12,2),
    discount_total numeric(12,2),
    total numeric(12,2) NOT NULL,
    notes text,
    converted_from_id uuid,
    created_by uuid,
    confirmed_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    public_token character varying(64),
    branch_id uuid NOT NULL,
    delivery_carrier character varying(150),
    delivery_tracking_number character varying(100),
    delivery_address character varying(500),
    delivery_dispatched_at timestamp(3) without time zone,
    delivery_estimated_at timestamp(3) without time zone,
    fulfillment_mode character varying(20) DEFAULT 'LEGACY'::character varying NOT NULL,
    payment_condition character varying(10) DEFAULT 'CASH'::character varying NOT NULL,
    credit_days integer,
    CONSTRAINT commercial_payment_terms_valid CHECK (((((payment_condition)::text = 'CASH'::text) AND (credit_days IS NULL)) OR (((payment_condition)::text = 'CREDIT'::text) AND (credit_days IS NOT NULL) AND ((credit_days >= 0) AND (credit_days <= 3650)))))
);
CREATE TABLE public.companies (
    id uuid NOT NULL,
    name character varying(150) NOT NULL,
    code character varying(20) NOT NULL,
    tax_id character varying(100),
    address text,
    phone character varying(50),
    logo_url character varying(500),
    active boolean DEFAULT true NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);
CREATE TABLE public.company_modules (
    company_id uuid NOT NULL,
    module_code character varying(50) NOT NULL,
    status public."CompanyModuleStatus" DEFAULT 'ACTIVE'::public."CompanyModuleStatus" NOT NULL,
    config jsonb,
    trial_ends_at timestamp(3) without time zone,
    activated_at timestamp(3) without time zone,
    suspended_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.customer_payment_refunds (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    engagement_id uuid NOT NULL,
    payment_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    status character varying(15) DEFAULT 'REQUESTED'::character varying NOT NULL,
    payment_method_id integer,
    cash_register_session_id uuid,
    reference character varying(255) DEFAULT ''::character varying NOT NULL,
    reason character varying(500) NOT NULL,
    request_key character varying(64) NOT NULL,
    confirmed_key character varying(64),
    input_hash character varying(64) NOT NULL,
    registered_by uuid NOT NULL,
    confirmed_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT refund_rules_check CHECK (((amount > (0)::numeric) AND ((status)::text = ANY ((ARRAY['REQUESTED'::character varying, 'CONFIRMED'::character varying, 'CANCELLED'::character varying])::text[])) AND (((status)::text = 'CONFIRMED'::text) = ((confirmed_at IS NOT NULL) AND (confirmed_key IS NOT NULL)))))
);
CREATE TABLE public.customer_payments (
    id uuid NOT NULL,
    branch_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    paid_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    payment_method_id integer,
    cash_register_session_id uuid,
    reference character varying(255),
    notes text,
    registered_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    kind public."CustomerPaymentKind" DEFAULT 'PAYMENT'::public."CustomerPaymentKind" NOT NULL
);
CREATE TABLE public.customer_price_rules (
    id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    channel public."SalesChannel",
    price_tier public."PriceTier" NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.employee_advances (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    date date NOT NULL,
    amount numeric(12,2) NOT NULL,
    installment numeric(12,2) NOT NULL,
    balance numeric(12,2) NOT NULL,
    reason text,
    status public."AdvanceStatus" DEFAULT 'PENDIENTE'::public."AdvanceStatus" NOT NULL,
    created_by uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);
CREATE TABLE public.employee_document_types (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    instructions character varying(500) DEFAULT ''::character varying NOT NULL,
    required boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    CONSTRAINT employee_document_types_sort_order_check CHECK ((sort_order >= 0))
);
CREATE TABLE public.employee_documents (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    type_id uuid NOT NULL,
    storage_path character varying(500) NOT NULL,
    original_name character varying(255) NOT NULL,
    mime_type character varying(100) NOT NULL,
    size_bytes integer NOT NULL,
    sha256 character varying(64) NOT NULL,
    uploaded_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    archived_at timestamp(3) without time zone,
    CONSTRAINT employee_documents_size_bytes_check CHECK (((size_bytes > 0) AND (size_bytes <= 5242880)))
);
CREATE TABLE public.employee_history (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    actor_id uuid,
    event character varying(100) NOT NULL,
    changes jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.employees (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    code character varying(20) NOT NULL,
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    dpi character varying(20),
    nit character varying(20),
    igss_number character varying(20),
    birth_date date,
    phone character varying(50),
    email character varying(150),
    address text,
    photo_url character varying(500),
    "position" character varying(100),
    department character varying(100),
    hire_date date NOT NULL,
    termination_date date,
    contract_type public."ContractType" DEFAULT 'INDEFINIDO'::public."ContractType" NOT NULL,
    pay_frequency public."PayFrequency" DEFAULT 'MENSUAL'::public."PayFrequency" NOT NULL,
    base_salary numeric(12,2) DEFAULT 0 NOT NULL,
    bonificacion_incentivo numeric(12,2) DEFAULT 250 NOT NULL,
    bank_account character varying(50),
    status public."EmployeeStatus" DEFAULT 'ACTIVO'::public."EmployeeStatus" NOT NULL,
    user_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    payment_method public."EmployeePaymentMethod" DEFAULT 'EFECTIVO'::public."EmployeePaymentMethod" NOT NULL,
    bank_name character varying(100),
    photo_storage_path character varying(500),
    gender character varying(50),
    marital_status character varying(50),
    nationality character varying(100),
    workday character varying(100),
    work_schedule character varying(200),
    supervisor_id uuid,
    creation_request_id uuid,
    creation_request_hash character varying(64)
);
CREATE TABLE public.incoming_merchandise (
    id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    registered_by uuid NOT NULL,
    date timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    notes text,
    payment_term_id integer,
    payment_status public."MerchandisePaymentStatus" DEFAULT 'PENDING'::public."MerchandisePaymentStatus" NOT NULL,
    paid_at timestamp(3) without time zone,
    payment_reference character varying(255),
    due_date timestamp(3) without time zone,
    payment_updated_by uuid,
    payment_updated_at timestamp(3) without time zone,
    branch_id uuid NOT NULL,
    source public."MerchandiseSource" DEFAULT 'PURCHASE'::public."MerchandiseSource" NOT NULL,
    legacy_settled_amount numeric(12,2) DEFAULT 0 NOT NULL,
    payment_revision integer DEFAULT 0 NOT NULL,
    payment_balance_review_required boolean DEFAULT false NOT NULL,
    CONSTRAINT incoming_merchandise_legacy_settled_amount_check CHECK ((legacy_settled_amount >= (0)::numeric)),
    CONSTRAINT incoming_merchandise_payment_revision_check CHECK ((payment_revision >= 0))
);
CREATE TABLE public.incoming_merchandise_items (
    id uuid NOT NULL,
    incoming_merchandise_id uuid NOT NULL,
    product_id uuid NOT NULL,
    quantity integer NOT NULL,
    unit_cost numeric(12,2) NOT NULL
);
CREATE TABLE public.incoming_merchandise_payment_entries (
    id uuid NOT NULL,
    incoming_merchandise_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    paid_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    reference character varying(255),
    registered_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    supplier_payment_id uuid,
    cancelled_at timestamp(3) without time zone,
    cancelled_by uuid,
    cancel_reason character varying(500)
);
CREATE TABLE public.inventory_count_lines (
    id uuid NOT NULL,
    session_id uuid NOT NULL,
    product_id uuid NOT NULL,
    stock_snapshot integer NOT NULL,
    qty_counted integer,
    counted_at timestamp(3) without time zone,
    counted_by_id uuid,
    note character varying(500),
    qty_counted_secondary integer,
    counted_secondary_at timestamp(3) without time zone,
    counted_secondary_by_id uuid,
    location_id uuid NOT NULL
);
CREATE TABLE public.inventory_count_sessions (
    id uuid NOT NULL,
    name character varying(200),
    status public."InventoryCountSessionStatus" DEFAULT 'DRAFT'::public."InventoryCountSessionStatus" NOT NULL,
    scope_json jsonb,
    created_by_id uuid NOT NULL,
    started_at timestamp(3) without time zone,
    submitted_at timestamp(3) without time zone,
    approved_at timestamp(3) without time zone,
    approved_by_id uuid,
    cancelled_at timestamp(3) without time zone,
    cancel_reason text,
    notes text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    dual_approval boolean DEFAULT false NOT NULL,
    submit_reason text,
    first_approved_at timestamp(3) without time zone,
    first_approved_by_id uuid,
    first_approval_reason text,
    final_approval_reason text,
    branch_id uuid NOT NULL,
    warehouse_id uuid
);
CREATE TABLE public.journal_entries (
    id uuid NOT NULL,
    entry_number character varying(20) NOT NULL,
    date timestamp(3) without time zone NOT NULL,
    description character varying(255) NOT NULL,
    source_type public."JournalSourceType" DEFAULT 'MANUAL'::public."JournalSourceType" NOT NULL,
    source_id character varying(64),
    reversal_of_id uuid,
    created_by uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid
);
CREATE TABLE public.journal_lines (
    id integer NOT NULL,
    entry_id uuid NOT NULL,
    account_id integer NOT NULL,
    debit numeric(12,2) DEFAULT 0 NOT NULL,
    credit numeric(12,2) DEFAULT 0 NOT NULL,
    description character varying(255)
);
CREATE SEQUENCE public.journal_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.journal_lines_id_seq OWNED BY public.journal_lines.id;
CREATE TABLE public.merchandise_payment_audit_events (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    incoming_merchandise_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    action character varying(50) NOT NULL,
    reason character varying(500),
    before jsonb NOT NULL,
    after jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.order_deliveries (
    id uuid NOT NULL,
    document_id uuid NOT NULL,
    request_key uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    notes character varying(1000),
    reversed_at timestamp(3) without time zone
);
CREATE TABLE public.order_delivery_lines (
    id uuid NOT NULL,
    delivery_id uuid NOT NULL,
    document_line_id uuid NOT NULL,
    qty numeric(12,4) NOT NULL,
    qty_invoiced numeric(12,4) DEFAULT 0 NOT NULL,
    unit_cost numeric(12,2),
    CONSTRAINT delivery_quantity_check CHECK (((qty > (0)::numeric) AND (qty_invoiced >= (0)::numeric) AND (qty_invoiced <= qty))),
    CONSTRAINT order_delivery_lines_check CHECK (((qty_invoiced >= (0)::numeric) AND (qty_invoiced <= qty))),
    CONSTRAINT order_delivery_lines_qty_check CHECK ((qty > (0)::numeric))
);
CREATE TABLE public.payment_allocation_events (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    engagement_id uuid NOT NULL,
    payment_id uuid NOT NULL,
    commitment_id uuid,
    action character varying(20) NOT NULL,
    amount numeric(12,2) NOT NULL,
    request_key character varying(64) NOT NULL,
    input_hash character varying(64) NOT NULL,
    actor_id uuid NOT NULL,
    reason character varying(500) DEFAULT ''::character varying NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    return_settlement_id uuid,
    CONSTRAINT allocation_rules_check CHECK (((amount > (0)::numeric) AND ((action)::text = ANY ((ARRAY['COMMITTED'::character varying, 'APPLIED'::character varying, 'RELEASED'::character varying, 'REFUND_REQUESTED'::character varying, 'REFUNDED'::character varying, 'REFUND_CANCELLED'::character varying, 'SALE_REFUNDED'::character varying, 'SALE_RELEASED'::character varying])::text[])))),
    CONSTRAINT allocation_sale_return_source_check CHECK ((((action)::text = ANY ((ARRAY['SALE_REFUNDED'::character varying, 'SALE_RELEASED'::character varying])::text[])) = (return_settlement_id IS NOT NULL)))
);
CREATE TABLE public.payment_commitments (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    engagement_id uuid NOT NULL,
    payment_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    state character varying(15) DEFAULT 'COMMITTED'::character varying NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT commitment_rules_check CHECK (((amount > (0)::numeric) AND (version > 0) AND ((state)::text = ANY ((ARRAY['COMMITTED'::character varying, 'APPLIED'::character varying, 'RELEASED'::character varying, 'REFUNDED'::character varying])::text[]))))
);
CREATE TABLE public.payment_methods (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    is_credit boolean DEFAULT false NOT NULL
);
CREATE SEQUENCE public.payment_methods_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.payment_methods_id_seq OWNED BY public.payment_methods.id;
CREATE TABLE public.payment_terms (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    net_days integer,
    company_id uuid NOT NULL
);
CREATE SEQUENCE public.payment_terms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.payment_terms_id_seq OWNED BY public.payment_terms.id;
CREATE TABLE public.payroll_runs (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    code character varying(20) NOT NULL,
    name character varying(150) NOT NULL,
    type public."PayrollType" DEFAULT 'ORDINARIA'::public."PayrollType" NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    pay_date date NOT NULL,
    status public."PayrollStatus" DEFAULT 'BORRADOR'::public."PayrollStatus" NOT NULL,
    total_earnings numeric(14,2) DEFAULT 0 NOT NULL,
    total_deductions numeric(14,2) DEFAULT 0 NOT NULL,
    total_net numeric(14,2) DEFAULT 0 NOT NULL,
    total_employer_cost numeric(14,2) DEFAULT 0 NOT NULL,
    notes text,
    created_by uuid,
    confirmed_by uuid,
    cancelled_by uuid,
    confirmed_at timestamp(3) without time zone,
    paid_at timestamp(3) without time zone,
    cancelled_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);
CREATE TABLE public.payslip_lines (
    id uuid NOT NULL,
    payslip_id uuid NOT NULL,
    concept public."PayrollConcept" NOT NULL,
    type public."PayslipLineType" NOT NULL,
    description character varying(150) NOT NULL,
    quantity numeric(10,2),
    amount numeric(12,2) NOT NULL,
    advance_id uuid,
    sort_order integer DEFAULT 0 NOT NULL
);
CREATE TABLE public.payslips (
    id uuid NOT NULL,
    run_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    base_salary numeric(12,2) NOT NULL,
    days_worked numeric(5,2) NOT NULL,
    igss_base numeric(12,2) DEFAULT 0 NOT NULL,
    isr_base numeric(12,2) DEFAULT 0 NOT NULL,
    total_earnings numeric(12,2) DEFAULT 0 NOT NULL,
    total_deductions numeric(12,2) DEFAULT 0 NOT NULL,
    net_pay numeric(12,2) DEFAULT 0 NOT NULL,
    employer_cost numeric(12,2) DEFAULT 0 NOT NULL
);
CREATE TABLE public.permissions (
    id integer NOT NULL,
    code character varying(100) NOT NULL,
    name character varying(150) NOT NULL,
    description text
);
CREATE SEQUENCE public.permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.permissions_id_seq OWNED BY public.permissions.id;
CREATE TABLE public.product_bom_lines (
    id uuid NOT NULL,
    kit_product_id uuid NOT NULL,
    component_product_id uuid NOT NULL,
    qty_per_unit integer DEFAULT 1 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);
CREATE TABLE public.product_categories (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    image_url character varying(500),
    company_id uuid NOT NULL
);
CREATE SEQUENCE public.product_categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.product_categories_id_seq OWNED BY public.product_categories.id;
CREATE TABLE public.product_lots (
    id uuid NOT NULL,
    product_id uuid NOT NULL,
    lot_code character varying(60),
    expiry_date date,
    qty_received integer NOT NULL,
    qty_remaining integer NOT NULL,
    unit_cost numeric(12,2),
    supplier_id uuid,
    incoming_merchandise_id uuid,
    received_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    branch_id uuid NOT NULL,
    location_id uuid,
    is_system_generated boolean DEFAULT false NOT NULL
);
CREATE TABLE public.product_stock_locations (
    id uuid NOT NULL,
    product_id uuid NOT NULL,
    location_id uuid NOT NULL,
    stock integer DEFAULT 0 NOT NULL,
    min_stock integer DEFAULT 0 NOT NULL
);
CREATE TABLE public.product_stocks (
    id uuid NOT NULL,
    product_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    stock integer DEFAULT 0 NOT NULL,
    min_stock integer DEFAULT 0 NOT NULL
);
CREATE TABLE public.products (
    id uuid NOT NULL,
    name character varying(150) NOT NULL,
    category_id integer NOT NULL,
    brand character varying(100),
    size character varying(50),
    stock integer DEFAULT 0 NOT NULL,
    min_stock integer DEFAULT 0 NOT NULL,
    price numeric(12,2) NOT NULL,
    cost numeric(12,2) NOT NULL,
    supplier_id uuid,
    barcode character varying(100),
    description text,
    status_id integer NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    deleted_at timestamp(3) without time zone,
    image_url character varying(500),
    price_wholesale numeric(12,2),
    price_promotion numeric(12,2),
    promotion_valid_until timestamp(3) without time zone,
    available_for_sale boolean DEFAULT true NOT NULL,
    kind public."ProductKind" DEFAULT 'STANDARD'::public."ProductKind" NOT NULL,
    tracks_expiry boolean DEFAULT false NOT NULL,
    stock_assembled boolean DEFAULT false NOT NULL,
    company_id uuid NOT NULL,
    service_unit_label character varying(50),
    quantity_decimals integer DEFAULT 0 NOT NULL,
    CONSTRAINT products_service_fields_check CHECK ((((quantity_decimals >= 0) AND (quantity_decimals <= 4)) AND
CASE
    WHEN (kind = 'SERVICE'::public."ProductKind") THEN ((supplier_id IS NULL) AND (stock = 0) AND (min_stock = 0) AND (cost = (0)::numeric) AND (NOT tracks_expiry) AND (NOT stock_assembled) AND (service_unit_label IS NOT NULL) AND ((length(TRIM(BOTH FROM service_unit_label)) >= 1) AND (length(TRIM(BOTH FROM service_unit_label)) <= 50)))
    ELSE ((supplier_id IS NOT NULL) AND (quantity_decimals = 0) AND (service_unit_label IS NULL))
END))
);
CREATE TABLE public.promotion_branches (
    promotion_id uuid NOT NULL,
    branch_id uuid NOT NULL
);
CREATE TABLE public.promotion_categories (
    id integer NOT NULL,
    promotion_id uuid NOT NULL,
    category_id integer NOT NULL
);
CREATE SEQUENCE public.promotion_categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.promotion_categories_id_seq OWNED BY public.promotion_categories.id;
CREATE TABLE public.promotion_codes (
    id integer NOT NULL,
    code character varying(50) NOT NULL,
    promotion_id uuid NOT NULL,
    current_uses integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    company_id uuid NOT NULL
);
CREATE SEQUENCE public.promotion_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.promotion_codes_id_seq OWNED BY public.promotion_codes.id;
CREATE TABLE public.promotion_coupon_assets (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    created_by uuid,
    draft_id uuid NOT NULL,
    promotion_id uuid,
    storage_path character varying(200) NOT NULL,
    status public."CouponAssetStatus" DEFAULT 'UPLOADING'::public."CouponAssetStatus" NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp(3) without time zone
);
CREATE TABLE public.promotion_products (
    id integer NOT NULL,
    promotion_id uuid NOT NULL,
    product_id uuid NOT NULL
);
CREATE SEQUENCE public.promotion_products_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.promotion_products_id_seq OWNED BY public.promotion_products.id;
CREATE TABLE public.promotion_types (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    description text
);
CREATE SEQUENCE public.promotion_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.promotion_types_id_seq OWNED BY public.promotion_types.id;
CREATE TABLE public.promotions (
    id uuid NOT NULL,
    name character varying(150) NOT NULL,
    description text,
    type_id integer NOT NULL,
    discount_value numeric(12,2),
    discount_percentage numeric(5,2),
    buy_quantity integer,
    get_quantity integer,
    min_quantity integer,
    applies_to_all boolean DEFAULT false NOT NULL,
    trigger_product_id uuid,
    target_product_id uuid,
    start_date timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    end_date timestamp(3) without time zone,
    max_uses integer,
    max_uses_per_customer integer,
    min_purchase_amount numeric(12,2),
    active boolean DEFAULT true NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    company_id uuid NOT NULL,
    applies_to_all_branches boolean DEFAULT true NOT NULL,
    coupon_design jsonb
);
CREATE TABLE public.purchase_logs (
    id integer NOT NULL,
    product_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    qty integer NOT NULL,
    date timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    cost numeric(12,2) NOT NULL,
    source public."MerchandiseSource" DEFAULT 'PURCHASE'::public."MerchandiseSource" NOT NULL
);
CREATE SEQUENCE public.purchase_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.purchase_logs_id_seq OWNED BY public.purchase_logs.id;
CREATE TABLE public.refresh_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash character varying(64) NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    revoked_at timestamp(3) without time zone,
    replaced_by character varying(64),
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    session_id uuid NOT NULL,
    device character varying(200)
);
CREATE TABLE public.return_items (
    id integer NOT NULL,
    return_id uuid NOT NULL,
    sale_item_id integer NOT NULL,
    product_id uuid NOT NULL,
    qty_returned numeric(12,4) NOT NULL,
    refund_amount numeric(12,2) NOT NULL,
    reason text,
    received_qty integer,
    restock_qty integer,
    disposition public."ReturnItemDisposition",
    stock_location_id uuid,
    CONSTRAINT return_quantity_positive CHECK ((qty_returned > (0)::numeric))
);
CREATE SEQUENCE public.return_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.return_items_id_seq OWNED BY public.return_items.id;
CREATE TABLE public.return_replacement_items (
    id integer NOT NULL,
    return_id uuid NOT NULL,
    product_id uuid NOT NULL,
    qty numeric(12,4) NOT NULL,
    unit_price numeric(12,2) NOT NULL,
    line_total numeric(12,2) NOT NULL,
    item_name character varying(150) NOT NULL,
    item_kind public."ProductKind" NOT NULL,
    unit_label character varying(50) NOT NULL,
    quantity_decimals integer DEFAULT 0 NOT NULL
);
CREATE SEQUENCE public.return_replacement_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.return_replacement_items_id_seq OWNED BY public.return_replacement_items.id;
CREATE TABLE public.return_settlements (
    id uuid NOT NULL,
    return_id uuid NOT NULL,
    kind public."ReturnSettlementKind" NOT NULL,
    amount numeric(12,2) NOT NULL,
    payment_method_id integer,
    cash_register_session_id uuid,
    external_reference character varying(255),
    registered_by uuid NOT NULL,
    idempotency_key character varying(64) NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.return_statuses (
    id integer NOT NULL,
    name character varying(50) NOT NULL
);
CREATE SEQUENCE public.return_statuses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.return_statuses_id_seq OWNED BY public.return_statuses.id;
CREATE TABLE public.returns (
    id uuid NOT NULL,
    sale_id uuid NOT NULL,
    return_date timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    reason text,
    total_refund numeric(12,2) NOT NULL,
    items_count integer DEFAULT 0 NOT NULL,
    status_id integer NOT NULL,
    processed_by uuid,
    processed_at timestamp(3) without time zone,
    notes text,
    price_difference numeric(12,2) DEFAULT 0 NOT NULL,
    type public."ReturnType" DEFAULT 'REFUND'::public."ReturnType" NOT NULL,
    reference character varying(30),
    requested_resolution public."ReturnResolution",
    approved_resolution public."ReturnResolution",
    approved_by uuid,
    approved_at timestamp(3) without time zone,
    policy_override_reason text,
    policy_overridden_by uuid,
    policy_overridden_at timestamp(3) without time zone,
    replacement_sale_id uuid,
    legacy_stock_reconciled boolean DEFAULT false NOT NULL,
    legacy_stock_moved boolean,
    version integer DEFAULT 1 NOT NULL
);
CREATE TABLE public.role_permissions (
    role_id integer NOT NULL,
    permission_id integer NOT NULL
);
CREATE TABLE public.roles (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    company_id uuid,
    description character varying(500),
    system_key character varying(16),
    legacy_role_id integer,
    revision integer DEFAULT 0 NOT NULL,
    name_key text GENERATED ALWAYS AS (lower(btrim((name)::text))) STORED,
    CONSTRAINT roles_local_reserved_name_check CHECK (((company_id IS NULL) OR (name_key <> ALL (ARRAY['admin'::text, 'administrador'::text])))),
    CONSTRAINT roles_revision_check CHECK ((revision >= 0)),
    CONSTRAINT roles_system_check CHECK (((system_key IS NULL) OR (((system_key)::text = 'ADMIN'::text) AND (company_id IS NULL) AND ((name)::text = 'admin'::text))))
);
CREATE SEQUENCE public.roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;
CREATE TABLE public.sale_dtes (
    id uuid NOT NULL,
    sale_id uuid NOT NULL,
    document_type character varying(50),
    "authorization" character varying(100),
    series character varying(20),
    number character varying(50),
    emission_date timestamp(3) without time zone,
    status character varying(50),
    provider character varying(50),
    xml_url character varying(500),
    pdf_url character varying(500),
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL
);
CREATE TABLE public.sale_history (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    sale_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    action character varying(40) NOT NULL,
    request_key character varying(64) NOT NULL,
    input_hash character varying(64) NOT NULL,
    before jsonb,
    after jsonb,
    reason text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.sale_items (
    id integer NOT NULL,
    sale_id uuid NOT NULL,
    product_id uuid NOT NULL,
    price numeric(12,2) NOT NULL,
    qty numeric(12,4) NOT NULL,
    unit_cost numeric(12,2),
    net_total numeric(12,2),
    item_name character varying(150) NOT NULL,
    item_kind public."ProductKind" NOT NULL,
    unit_label character varying(50) NOT NULL,
    quantity_decimals integer DEFAULT 0 NOT NULL
);
CREATE SEQUENCE public.sale_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.sale_items_id_seq OWNED BY public.sale_items.id;
CREATE TABLE public.sale_payment_entries (
    id uuid NOT NULL,
    sale_id uuid NOT NULL,
    customer_payment_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.sale_promotions (
    id integer NOT NULL,
    sale_id uuid NOT NULL,
    promotion_id uuid NOT NULL,
    discount_applied numeric(12,2) NOT NULL,
    code_used character varying(50)
);
CREATE SEQUENCE public.sale_promotions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.sale_promotions_id_seq OWNED BY public.sale_promotions.id;
CREATE TABLE public.sale_statuses (
    id integer NOT NULL,
    name character varying(50) NOT NULL
);
CREATE SEQUENCE public.sale_statuses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.sale_statuses_id_seq OWNED BY public.sale_statuses.id;
CREATE TABLE public.sales (
    id uuid NOT NULL,
    date timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    customer character varying(150),
    customer_nit character varying(50),
    is_final_consumer boolean DEFAULT true NOT NULL,
    total numeric(12,2) NOT NULL,
    items integer NOT NULL,
    payment_method_id integer,
    status_id integer NOT NULL,
    amount_received numeric(12,2),
    change numeric(12,2),
    sold_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    total_returned numeric(12,2) DEFAULT 0 NOT NULL,
    adjusted_total numeric(12,2) NOT NULL,
    discount_total numeric(12,2),
    subtotal numeric(12,2),
    created_by uuid,
    reference character varying(30),
    cash_register_session_id uuid,
    customer_contact_id uuid,
    sales_channel public."SalesChannel" DEFAULT 'POS'::public."SalesChannel" NOT NULL,
    branch_id uuid NOT NULL,
    idempotency_key character varying(64),
    due_date timestamp(3) without time zone,
    payment_status public."SalePaymentStatus" DEFAULT 'PAID'::public."SalePaymentStatus" NOT NULL,
    settlement_source character varying(30) DEFAULT 'LEGACY'::character varying NOT NULL,
    origin_engagement_id uuid,
    version integer DEFAULT 1 NOT NULL,
    confirmed_at timestamp(3) without time zone,
    CONSTRAINT sale_settlement_source_check CHECK (((settlement_source)::text = ANY ((ARRAY['LEGACY'::character varying, 'ENGAGEMENT_RECEIPTS'::character varying])::text[])))
);
ALTER TABLE ONLY public.sales REPLICA IDENTITY FULL;
CREATE TABLE public.schedule_calendars (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    owner_type character varying(20) NOT NULL,
    branch_id uuid,
    provider_id uuid,
    resource_id uuid,
    timezone character varying(100) NOT NULL,
    valid_from date,
    valid_until date,
    inherit_branch boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    CONSTRAINT schedule_calendar_owner_check CHECK (((version > 0) AND (num_nonnulls(branch_id, provider_id, resource_id) = 1) AND ((((owner_type)::text = 'branch'::text) AND (branch_id IS NOT NULL) AND (NOT inherit_branch)) OR (((owner_type)::text = 'provider'::text) AND (provider_id IS NOT NULL)) OR (((owner_type)::text = 'resource'::text) AND (resource_id IS NOT NULL))) AND ((valid_from IS NULL) OR (valid_until IS NULL) OR (valid_from <= valid_until))))
);
CREATE TABLE public.schedule_resources (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    name character varying(150) NOT NULL,
    type character varying(20) NOT NULL,
    person_capacity integer,
    active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    portable boolean DEFAULT false NOT NULL,
    CONSTRAINT schedule_resource_capacity_check CHECK ((((type)::text = ANY ((ARRAY['ROOM'::character varying, 'EQUIPMENT'::character varying])::text[])) AND (version > 0) AND ((person_capacity IS NULL) OR ((person_capacity >= 1) AND (person_capacity <= 10000))) AND (((type)::text <> 'ROOM'::text) OR (person_capacity IS NOT NULL)))),
    CONSTRAINT schedule_resource_portable_check CHECK ((((type)::text <> 'ROOM'::text) OR (NOT portable)))
);
CREATE TABLE public.service_provider_branches (
    company_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    branch_id uuid NOT NULL
);
CREATE TABLE public.service_providers (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    employee_id uuid,
    user_id uuid,
    name character varying(150) NOT NULL,
    active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    CONSTRAINT service_provider_version_check CHECK ((version > 0))
);
CREATE TABLE public.service_schedule_branches (
    company_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    branch_id uuid NOT NULL
);
CREATE TABLE public.service_schedule_profiles (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    product_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    mode character varying(20) NOT NULL,
    duration_minutes integer NOT NULL,
    before_minutes integer DEFAULT 0 NOT NULL,
    after_minutes integer DEFAULT 0 NOT NULL,
    interval_minutes integer DEFAULT 15 NOT NULL,
    lead_minutes integer DEFAULT 0 NOT NULL,
    horizon_days integer DEFAULT 60 NOT NULL,
    cancellation_hours integer DEFAULT 24 NOT NULL,
    confirmation character varying(20) DEFAULT 'AUTOMATIC'::character varying NOT NULL,
    capacity integer DEFAULT 1 NOT NULL,
    requires_provider boolean DEFAULT true NOT NULL,
    requires_resource boolean DEFAULT false NOT NULL,
    instructions character varying(2000) DEFAULT ''::character varying NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    allowed_venue_kinds text[] DEFAULT ARRAY['BRANCH'::text] NOT NULL,
    scheduling_style character varying(20) DEFAULT 'APPOINTMENT'::character varying NOT NULL,
    duration_policy character varying(20) DEFAULT 'FIXED'::character varying NOT NULL,
    public_instructions character varying(2000) DEFAULT ''::character varying NOT NULL,
    completion_policy character varying(10) DEFAULT 'MANUAL'::character varying NOT NULL,
    CONSTRAINT service_completion_policy_check CHECK ((((completion_policy)::text = 'MANUAL'::text) OR (((completion_policy)::text = 'AUTO'::text) AND ((scheduling_style)::text = 'WORK'::text)))),
    CONSTRAINT service_profile_venue_check CHECK ((((cardinality(allowed_venue_kinds) >= 1) AND (cardinality(allowed_venue_kinds) <= 4)) AND (allowed_venue_kinds <@ ARRAY['BRANCH'::text, 'HOME'::text, 'EVENT_VENUE'::text, 'ONLINE'::text]))),
    CONSTRAINT service_schedule_profile_rules_check CHECK ((((mode)::text = ANY ((ARRAY['INDIVIDUAL'::character varying, 'GROUP'::character varying])::text[])) AND ((scheduling_style)::text = ANY ((ARRAY['APPOINTMENT'::character varying, 'CLASS'::character varying, 'WORK'::character varying])::text[])) AND ((duration_policy)::text = ANY ((ARRAY['FIXED'::character varying, 'EDITABLE'::character varying])::text[])) AND ((((scheduling_style)::text = 'CLASS'::text) AND ((mode)::text = 'GROUP'::text)) OR (((scheduling_style)::text = ANY ((ARRAY['APPOINTMENT'::character varying, 'WORK'::character varying])::text[])) AND ((mode)::text = 'INDIVIDUAL'::text))) AND ((duration_minutes >= 1) AND (duration_minutes <=
CASE
    WHEN ((scheduling_style)::text = 'WORK'::text) THEN 44640
    ELSE 1440
END)) AND ((before_minutes >= 0) AND (before_minutes <= 1440)) AND ((after_minutes >= 0) AND (after_minutes <= 1440)) AND ((interval_minutes >= 1) AND (interval_minutes <= 1440)) AND ((lead_minutes >= 0) AND (lead_minutes <= 525600)) AND ((horizon_days >= 1) AND (horizon_days <= 365)) AND ((cancellation_hours >= 0) AND (cancellation_hours <= 8760)) AND ((confirmation)::text = ANY ((ARRAY['AUTOMATIC'::character varying, 'MANUAL'::character varying])::text[])) AND ((capacity >= 1) AND (capacity <= 10000)) AND (((mode)::text <> 'INDIVIDUAL'::text) OR (capacity = 1)) AND (version > 0)))
);
CREATE TABLE public.service_schedule_providers (
    company_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    provider_id uuid NOT NULL
);
CREATE TABLE public.service_schedule_resources (
    company_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    resource_id uuid NOT NULL
);
CREATE TABLE public.statuses (
    id integer NOT NULL,
    name character varying(50) NOT NULL
);
CREATE SEQUENCE public.statuses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.statuses_id_seq OWNED BY public.statuses.id;
CREATE TABLE public.stock_locations (
    id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    code character varying(30) NOT NULL,
    name character varying(120),
    is_default boolean DEFAULT false NOT NULL,
    pickable boolean DEFAULT true NOT NULL,
    dispatch_priority integer DEFAULT 100 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.stock_movements (
    id uuid NOT NULL,
    branch_id uuid NOT NULL,
    location_id uuid NOT NULL,
    product_id uuid NOT NULL,
    qty integer NOT NULL,
    balance integer NOT NULL,
    reason public."StockMovementReason" NOT NULL,
    ref_type character varying(30),
    ref_id uuid,
    group_id uuid,
    notes character varying(300),
    created_by uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.stock_reservations (
    id uuid NOT NULL,
    product_id uuid NOT NULL,
    document_id uuid NOT NULL,
    document_line_id uuid NOT NULL,
    qty integer NOT NULL,
    status public."StockReservationStatus" DEFAULT 'ACTIVE'::public."StockReservationStatus" NOT NULL,
    expires_at timestamp(3) without time zone,
    created_by uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    released_at timestamp(3) without time zone,
    consumed_at timestamp(3) without time zone,
    reservation_kind public."StockReservationKind" DEFAULT 'ORDER'::public."StockReservationKind" NOT NULL,
    branch_id uuid NOT NULL
);
CREATE TABLE public.stock_statuses (
    id integer NOT NULL,
    name character varying(50) NOT NULL
);
CREATE SEQUENCE public.stock_statuses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.stock_statuses_id_seq OWNED BY public.stock_statuses.id;
CREATE TABLE public.stock_transfer_lines (
    id uuid NOT NULL,
    transfer_id uuid NOT NULL,
    product_id uuid NOT NULL,
    qty_sent integer NOT NULL,
    qty_received integer,
    lots_snapshot jsonb
);
CREATE TABLE public.stock_transfers (
    id uuid NOT NULL,
    reference character varying(30) NOT NULL,
    from_branch_id uuid NOT NULL,
    to_branch_id uuid NOT NULL,
    status public."StockTransferStatus" DEFAULT 'EN_TRANSITO'::public."StockTransferStatus" NOT NULL,
    created_by uuid NOT NULL,
    sent_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    received_by uuid,
    received_at timestamp(3) without time zone,
    cancelled_at timestamp(3) without time zone,
    notes text
);
CREATE TABLE public.supplier_categories (
    supplier_id uuid NOT NULL,
    category_id integer NOT NULL
);
CREATE TABLE public.supplier_payment_terms (
    supplier_id uuid NOT NULL,
    payment_term_id integer NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);
CREATE TABLE public.supplier_payments (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    currency_code character varying(3) NOT NULL,
    paid_at timestamp(3) without time zone NOT NULL,
    payment_method_id integer,
    reference character varying(255),
    notes text,
    registered_by uuid NOT NULL,
    request_key uuid NOT NULL,
    request_hash character varying(64) NOT NULL,
    status public."SupplierPaymentStatus" DEFAULT 'POSTED'::public."SupplierPaymentStatus" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    cancelled_at timestamp(3) without time zone,
    cancelled_by uuid,
    cancel_reason character varying(500),
    CONSTRAINT supplier_payments_amount_check CHECK ((amount > (0)::numeric))
);
CREATE TABLE public.suppliers (
    id uuid NOT NULL,
    name character varying(150) NOT NULL,
    contact character varying(100) NOT NULL,
    phone character varying(50),
    email character varying(150),
    address text,
    products integer DEFAULT 0 NOT NULL,
    last_order timestamp(3) without time zone,
    total_purchases numeric(12,2) DEFAULT 0 NOT NULL,
    rating numeric(3,2),
    deleted boolean DEFAULT false NOT NULL,
    deleted_at timestamp(3) without time zone,
    estado integer DEFAULT 1 NOT NULL,
    party_type public."SupplierPartyType" DEFAULT 'SUPPLIER'::public."SupplierPartyType" NOT NULL,
    tax_id character varying(100),
    entity_kind public."ContactEntityKind" DEFAULT 'ORGANIZATION'::public."ContactEntityKind" NOT NULL,
    default_price_tier public."PriceTier" DEFAULT 'LIST'::public."PriceTier" NOT NULL,
    company_id uuid NOT NULL,
    credit_limit numeric(12,2),
    image_storage_path character varying(500)
);
CREATE TABLE public.system_settings (
    id integer NOT NULL,
    key character varying(100) NOT NULL,
    value text NOT NULL,
    type character varying(50),
    description character varying(255),
    updated_at timestamp(3) without time zone NOT NULL,
    company_id uuid NOT NULL
);
CREATE SEQUENCE public.system_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.system_settings_id_seq OWNED BY public.system_settings.id;
CREATE TABLE public.user_access_events (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    user_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    action character varying(100) NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.user_branches (
    user_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.user_companies (
    user_id uuid NOT NULL,
    company_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    experience_profile public."ExperienceProfile",
    status character varying(12) DEFAULT 'ACTIVE'::character varying NOT NULL,
    role_id integer,
    last_access_at timestamp(3) without time zone,
    CONSTRAINT user_companies_status_check CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying, 'BLOCKED'::character varying])::text[])))
);
CREATE TABLE public.users (
    id uuid NOT NULL,
    name character varying(150) NOT NULL,
    email character varying(150) NOT NULL,
    password character varying(255) NOT NULL,
    role_id integer NOT NULL,
    photo_url character varying(500),
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    cash_register_id uuid,
    default_branch_id uuid,
    auth_version integer DEFAULT 0 NOT NULL,
    last_login_at timestamp(3) without time zone,
    password_changed_at timestamp(3) without time zone
);
CREATE TABLE public.warehouses (
    id uuid NOT NULL,
    branch_id uuid NOT NULL,
    name character varying(120) NOT NULL,
    code character varying(20) NOT NULL,
    kind public."WarehouseKind" DEFAULT 'BODEGA'::public."WarehouseKind" NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_receiving boolean DEFAULT false NOT NULL,
    dispatch_priority integer DEFAULT 100 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);
ALTER TABLE ONLY public.accounting_periods ALTER COLUMN id SET DEFAULT nextval('public.accounting_periods_id_seq'::regclass);
ALTER TABLE ONLY public.accounts ALTER COLUMN id SET DEFAULT nextval('public.accounts_id_seq'::regclass);
ALTER TABLE ONLY public.alert_priorities ALTER COLUMN id SET DEFAULT nextval('public.alert_priorities_id_seq'::regclass);
ALTER TABLE ONLY public.alert_types ALTER COLUMN id SET DEFAULT nextval('public.alert_types_id_seq'::regclass);
ALTER TABLE ONLY public.branches ALTER COLUMN seq SET DEFAULT nextval('public.branches_seq_seq'::regclass);
ALTER TABLE ONLY public.cash_closure_denominations ALTER COLUMN id SET DEFAULT nextval('public.cash_closure_denominations_id_seq'::regclass);
ALTER TABLE ONLY public.cash_closure_payments ALTER COLUMN id SET DEFAULT nextval('public.cash_closure_payments_id_seq'::regclass);
ALTER TABLE ONLY public.cash_closures ALTER COLUMN closure_number SET DEFAULT nextval('public.cash_closures_closure_number_seq'::regclass);
ALTER TABLE ONLY public.journal_lines ALTER COLUMN id SET DEFAULT nextval('public.journal_lines_id_seq'::regclass);
ALTER TABLE ONLY public.payment_methods ALTER COLUMN id SET DEFAULT nextval('public.payment_methods_id_seq'::regclass);
ALTER TABLE ONLY public.payment_terms ALTER COLUMN id SET DEFAULT nextval('public.payment_terms_id_seq'::regclass);
ALTER TABLE ONLY public.permissions ALTER COLUMN id SET DEFAULT nextval('public.permissions_id_seq'::regclass);
ALTER TABLE ONLY public.product_categories ALTER COLUMN id SET DEFAULT nextval('public.product_categories_id_seq'::regclass);
ALTER TABLE ONLY public.promotion_categories ALTER COLUMN id SET DEFAULT nextval('public.promotion_categories_id_seq'::regclass);
ALTER TABLE ONLY public.promotion_codes ALTER COLUMN id SET DEFAULT nextval('public.promotion_codes_id_seq'::regclass);
ALTER TABLE ONLY public.promotion_products ALTER COLUMN id SET DEFAULT nextval('public.promotion_products_id_seq'::regclass);
ALTER TABLE ONLY public.promotion_types ALTER COLUMN id SET DEFAULT nextval('public.promotion_types_id_seq'::regclass);
ALTER TABLE ONLY public.purchase_logs ALTER COLUMN id SET DEFAULT nextval('public.purchase_logs_id_seq'::regclass);
ALTER TABLE ONLY public.return_items ALTER COLUMN id SET DEFAULT nextval('public.return_items_id_seq'::regclass);
ALTER TABLE ONLY public.return_replacement_items ALTER COLUMN id SET DEFAULT nextval('public.return_replacement_items_id_seq'::regclass);
ALTER TABLE ONLY public.return_statuses ALTER COLUMN id SET DEFAULT nextval('public.return_statuses_id_seq'::regclass);
ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);
ALTER TABLE ONLY public.sale_items ALTER COLUMN id SET DEFAULT nextval('public.sale_items_id_seq'::regclass);
ALTER TABLE ONLY public.sale_promotions ALTER COLUMN id SET DEFAULT nextval('public.sale_promotions_id_seq'::regclass);
ALTER TABLE ONLY public.sale_statuses ALTER COLUMN id SET DEFAULT nextval('public.sale_statuses_id_seq'::regclass);
ALTER TABLE ONLY public.statuses ALTER COLUMN id SET DEFAULT nextval('public.statuses_id_seq'::regclass);
ALTER TABLE ONLY public.stock_statuses ALTER COLUMN id SET DEFAULT nextval('public.stock_statuses_id_seq'::regclass);
ALTER TABLE ONLY public.system_settings ALTER COLUMN id SET DEFAULT nextval('public.system_settings_id_seq'::regclass);
ALTER TABLE ONLY public.accounting_periods
    ADD CONSTRAINT accounting_periods_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.alert_priorities
    ADD CONSTRAINT alert_priorities_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.alert_types
    ADD CONSTRAINT alert_types_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.appointment_bookings
    ADD CONSTRAINT appointment_bookings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.appointment_engagement_history
    ADD CONSTRAINT appointment_engagement_history_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.appointment_engagement_lines
    ADD CONSTRAINT appointment_engagement_lines_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.appointment_engagement_schedules
    ADD CONSTRAINT appointment_engagement_schedules_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.appointment_engagements
    ADD CONSTRAINT appointment_engagements_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.appointment_history
    ADD CONSTRAINT appointment_history_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.appointment_participants
    ADD CONSTRAINT appointment_participants_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.appointment_requests
    ADD CONSTRAINT appointment_requests_pkey PRIMARY KEY (company_id, actor_id, operation, idempotency_key);
ALTER TABLE ONLY public.appointment_session_providers
    ADD CONSTRAINT appointment_session_providers_pkey PRIMARY KEY (session_id, provider_id);
ALTER TABLE ONLY public.appointment_session_resources
    ADD CONSTRAINT appointment_session_resources_pkey PRIMARY KEY (session_id, resource_id);
ALTER TABLE ONLY public.appointment_sessions
    ADD CONSTRAINT appointment_sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.appointment_waitlist
    ADD CONSTRAINT appointment_waitlist_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.attendance
    ADD CONSTRAINT attendance_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.availability_exceptions
    ADD CONSTRAINT availability_exceptions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.availability_rules
    ADD CONSTRAINT availability_rules_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.barcode_print_preparations
    ADD CONSTRAINT barcode_print_preparations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.cash_closure_denominations
    ADD CONSTRAINT cash_closure_denominations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.cash_closure_payments
    ADD CONSTRAINT cash_closure_payments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.cash_closures
    ADD CONSTRAINT cash_closures_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.cash_register_sessions
    ADD CONSTRAINT cash_register_sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.cash_registers
    ADD CONSTRAINT cash_registers_pkey PRIMARY KEY (id);
ALTER TABLE public.commercial_document_lines
    ADD CONSTRAINT commercial_document_lines_commercial_quantity_check CHECK ((((quantity_decimals >= 0) AND (quantity_decimals <= 4)) AND ((item_kind = 'SERVICE'::public."ProductKind") OR (quantity_decimals = 0)) AND (qty > (0)::numeric) AND (qty = trunc(qty, quantity_decimals)) AND (length(TRIM(BOTH FROM item_name)) > 0) AND (length(TRIM(BOTH FROM unit_label)) > 0))) NOT VALID;
ALTER TABLE ONLY public.commercial_document_lines
    ADD CONSTRAINT commercial_document_lines_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.commercial_document_sales
    ADD CONSTRAINT commercial_document_sales_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.commercial_documents
    ADD CONSTRAINT commercial_documents_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.company_modules
    ADD CONSTRAINT company_modules_pkey PRIMARY KEY (company_id, module_code);
ALTER TABLE ONLY public.customer_payment_refunds
    ADD CONSTRAINT customer_payment_refunds_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.customer_payments
    ADD CONSTRAINT customer_payments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.customer_price_rules
    ADD CONSTRAINT customer_price_rules_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.employee_advances
    ADD CONSTRAINT employee_advances_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.employee_document_types
    ADD CONSTRAINT employee_document_types_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.employee_history
    ADD CONSTRAINT employee_history_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.incoming_merchandise_items
    ADD CONSTRAINT incoming_merchandise_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.incoming_merchandise_payment_entries
    ADD CONSTRAINT incoming_merchandise_payment_entries_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.incoming_merchandise_payment_entries
    ADD CONSTRAINT incoming_merchandise_payment_entries_supplier_payment_id_inc_ke UNIQUE (supplier_payment_id, incoming_merchandise_id);
ALTER TABLE ONLY public.incoming_merchandise
    ADD CONSTRAINT incoming_merchandise_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.inventory_count_lines
    ADD CONSTRAINT inventory_count_lines_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.inventory_count_sessions
    ADD CONSTRAINT inventory_count_sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.journal_lines
    ADD CONSTRAINT journal_lines_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merchandise_payment_audit_events
    ADD CONSTRAINT merchandise_payment_audit_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.order_deliveries
    ADD CONSTRAINT order_deliveries_document_id_request_key_key UNIQUE (document_id, request_key);
ALTER TABLE ONLY public.order_deliveries
    ADD CONSTRAINT order_deliveries_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.order_delivery_lines
    ADD CONSTRAINT order_delivery_lines_delivery_id_document_line_id_key UNIQUE (delivery_id, document_line_id);
ALTER TABLE ONLY public.order_delivery_lines
    ADD CONSTRAINT order_delivery_lines_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payment_allocation_events
    ADD CONSTRAINT payment_allocation_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payment_commitments
    ADD CONSTRAINT payment_commitments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payment_terms
    ADD CONSTRAINT payment_terms_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payslip_lines
    ADD CONSTRAINT payslip_lines_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT payslips_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_code_key UNIQUE (code);
ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.product_bom_lines
    ADD CONSTRAINT product_bom_lines_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.product_categories
    ADD CONSTRAINT product_categories_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.product_lots
    ADD CONSTRAINT product_lots_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.product_stock_locations
    ADD CONSTRAINT product_stock_locations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.product_stocks
    ADD CONSTRAINT product_stocks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.promotion_branches
    ADD CONSTRAINT promotion_branches_pkey PRIMARY KEY (promotion_id, branch_id);
ALTER TABLE ONLY public.promotion_categories
    ADD CONSTRAINT promotion_categories_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.promotion_codes
    ADD CONSTRAINT promotion_codes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.promotion_coupon_assets
    ADD CONSTRAINT promotion_coupon_assets_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.promotion_coupon_assets
    ADD CONSTRAINT promotion_coupon_assets_storage_path_key UNIQUE (storage_path);
ALTER TABLE ONLY public.promotion_products
    ADD CONSTRAINT promotion_products_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.promotion_types
    ADD CONSTRAINT promotion_types_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.promotions
    ADD CONSTRAINT promotions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.purchase_logs
    ADD CONSTRAINT purchase_logs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.return_items
    ADD CONSTRAINT return_items_pkey PRIMARY KEY (id);
ALTER TABLE public.return_replacement_items
    ADD CONSTRAINT return_replacement_items_commercial_quantity_check CHECK ((((quantity_decimals >= 0) AND (quantity_decimals <= 4)) AND ((item_kind = 'SERVICE'::public."ProductKind") OR (quantity_decimals = 0)) AND (qty > (0)::numeric) AND (qty = trunc(qty, quantity_decimals)) AND (length(TRIM(BOTH FROM item_name)) > 0) AND (length(TRIM(BOTH FROM unit_label)) > 0))) NOT VALID;
ALTER TABLE ONLY public.return_replacement_items
    ADD CONSTRAINT return_replacement_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.return_settlements
    ADD CONSTRAINT return_settlements_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.return_statuses
    ADD CONSTRAINT return_statuses_name_key UNIQUE (name);
ALTER TABLE ONLY public.return_statuses
    ADD CONSTRAINT return_statuses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.returns
    ADD CONSTRAINT returns_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_id);
ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.sale_dtes
    ADD CONSTRAINT sale_dtes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.sale_history
    ADD CONSTRAINT sale_history_pkey PRIMARY KEY (id);
ALTER TABLE public.sale_items
    ADD CONSTRAINT sale_items_commercial_quantity_check CHECK ((((quantity_decimals >= 0) AND (quantity_decimals <= 4)) AND ((item_kind = 'SERVICE'::public."ProductKind") OR (quantity_decimals = 0)) AND (qty > (0)::numeric) AND (qty = trunc(qty, quantity_decimals)) AND (length(TRIM(BOTH FROM item_name)) > 0) AND (length(TRIM(BOTH FROM unit_label)) > 0))) NOT VALID;
ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.sale_payment_entries
    ADD CONSTRAINT sale_payment_entries_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.sale_promotions
    ADD CONSTRAINT sale_promotions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.sale_statuses
    ADD CONSTRAINT sale_statuses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.schedule_calendars
    ADD CONSTRAINT schedule_calendars_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.schedule_resources
    ADD CONSTRAINT schedule_resources_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.service_provider_branches
    ADD CONSTRAINT service_provider_branches_pkey PRIMARY KEY (provider_id, branch_id);
ALTER TABLE ONLY public.service_providers
    ADD CONSTRAINT service_providers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.service_schedule_branches
    ADD CONSTRAINT service_schedule_branches_pkey PRIMARY KEY (profile_id, branch_id);
ALTER TABLE ONLY public.service_schedule_profiles
    ADD CONSTRAINT service_schedule_profiles_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.service_schedule_providers
    ADD CONSTRAINT service_schedule_providers_pkey PRIMARY KEY (profile_id, provider_id);
ALTER TABLE ONLY public.service_schedule_resources
    ADD CONSTRAINT service_schedule_resources_pkey PRIMARY KEY (profile_id, resource_id);
ALTER TABLE ONLY public.statuses
    ADD CONSTRAINT statuses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.stock_locations
    ADD CONSTRAINT stock_locations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.stock_statuses
    ADD CONSTRAINT stock_statuses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.stock_transfer_lines
    ADD CONSTRAINT stock_transfer_lines_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.supplier_categories
    ADD CONSTRAINT supplier_categories_pkey PRIMARY KEY (supplier_id, category_id);
ALTER TABLE ONLY public.supplier_payment_terms
    ADD CONSTRAINT supplier_payment_terms_pkey PRIMARY KEY (supplier_id, payment_term_id);
ALTER TABLE ONLY public.supplier_payments
    ADD CONSTRAINT supplier_payments_company_id_registered_by_request_key_key UNIQUE (company_id, registered_by, request_key);
ALTER TABLE ONLY public.supplier_payments
    ADD CONSTRAINT supplier_payments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_access_events
    ADD CONSTRAINT user_access_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_branches
    ADD CONSTRAINT user_branches_pkey PRIMARY KEY (user_id, branch_id);
ALTER TABLE ONLY public.user_companies
    ADD CONSTRAINT user_companies_pkey PRIMARY KEY (user_id, company_id);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX accounting_periods_company_id_year_month_key ON public.accounting_periods USING btree (company_id, year, month);
CREATE UNIQUE INDEX accounts_company_id_code_key ON public.accounts USING btree (company_id, code);
CREATE UNIQUE INDEX alert_priorities_name_key ON public.alert_priorities USING btree (name);
CREATE UNIQUE INDEX alert_types_name_key ON public.alert_types USING btree (name);
CREATE INDEX alerts_branch_id_idx ON public.alerts USING btree (branch_id);
CREATE UNIQUE INDEX allocation_attempt_key ON public.payment_allocation_events USING btree (company_id, payment_id, request_key, action);
CREATE UNIQUE INDEX appointment_booking_active_contact_key ON public.appointment_bookings USING btree (company_id, session_id, contact_id) WHERE ((status)::text = ANY ((ARRAY['HELD'::character varying, 'PENDING'::character varying, 'CONFIRMED'::character varying, 'ARRIVED'::character varying, 'IN_SERVICE'::character varying])::text[]));
CREATE INDEX appointment_bookings_company_id_branch_id_status_expires_at_idx ON public.appointment_bookings USING btree (company_id, branch_id, status, expires_at);
CREATE INDEX appointment_bookings_company_id_contact_id_created_at_idx ON public.appointment_bookings USING btree (company_id, contact_id, created_at);
CREATE UNIQUE INDEX appointment_bookings_company_id_id_key ON public.appointment_bookings USING btree (company_id, id);
CREATE INDEX appointment_bookings_company_id_session_id_status_idx ON public.appointment_bookings USING btree (company_id, session_id, status);
CREATE INDEX appointment_engagement_history_company_id_engagement_id_cre_idx ON public.appointment_engagement_history USING btree (company_id, engagement_id, created_at);
CREATE UNIQUE INDEX appointment_engagement_lines_engagement_id_source_line_id_key ON public.appointment_engagement_lines USING btree (engagement_id, source_line_id);
CREATE UNIQUE INDEX appointment_engagement_schedules_booking_id_key ON public.appointment_engagement_schedules USING btree (booking_id);
CREATE INDEX appointment_engagement_schedules_company_id_engagement_id_s_idx ON public.appointment_engagement_schedules USING btree (company_id, engagement_id, state);
CREATE UNIQUE INDEX appointment_engagement_schedules_line_id_session_id_key ON public.appointment_engagement_schedules USING btree (line_id, session_id);
CREATE INDEX appointment_engagements_company_id_branch_id_created_at_idx ON public.appointment_engagements USING btree (company_id, branch_id, created_at);
CREATE UNIQUE INDEX appointment_engagements_order_id_key ON public.appointment_engagements USING btree (order_id);
CREATE UNIQUE INDEX appointment_engagements_quote_id_key ON public.appointment_engagements USING btree (quote_id);
CREATE UNIQUE INDEX appointment_engagements_sale_id_key ON public.appointment_engagements USING btree (sale_id);
CREATE INDEX appointment_history_company_id_booking_id_created_at_idx ON public.appointment_history USING btree (company_id, booking_id, created_at);
CREATE INDEX appointment_history_company_id_session_id_created_at_idx ON public.appointment_history USING btree (company_id, session_id, created_at);
CREATE INDEX appointment_organizer_occupied_idx ON public.appointment_sessions USING btree (company_id, organizer_id, occupied_from, occupied_until);
CREATE INDEX appointment_participants_company_id_user_id_session_id_idx ON public.appointment_participants USING btree (company_id, user_id, session_id);
CREATE UNIQUE INDEX appointment_participants_session_id_contact_id_key ON public.appointment_participants USING btree (session_id, contact_id);
CREATE UNIQUE INDEX appointment_participants_session_id_user_id_key ON public.appointment_participants USING btree (session_id, user_id);
CREATE UNIQUE INDEX appointment_session_branch_type_key ON public.appointment_sessions USING btree (company_id, branch_id, id, record_type);
CREATE INDEX appointment_session_providers_company_id_provider_id_sessio_idx ON public.appointment_session_providers USING btree (company_id, provider_id, session_id);
CREATE INDEX appointment_session_resources_company_id_resource_id_sessio_idx ON public.appointment_session_resources USING btree (company_id, resource_id, session_id);
CREATE UNIQUE INDEX appointment_session_type_key ON public.appointment_sessions USING btree (company_id, id, record_type);
CREATE UNIQUE INDEX appointment_sessions_company_id_branch_id_id_key ON public.appointment_sessions USING btree (company_id, branch_id, id);
CREATE INDEX appointment_sessions_company_id_branch_id_starts_at_idx ON public.appointment_sessions USING btree (company_id, branch_id, starts_at);
CREATE UNIQUE INDEX appointment_sessions_company_id_id_key ON public.appointment_sessions USING btree (company_id, id);
CREATE INDEX appointment_sessions_company_id_occupied_from_occupied_unti_idx ON public.appointment_sessions USING btree (company_id, occupied_from, occupied_until);
CREATE UNIQUE INDEX appointment_waitlist_active_contact_key ON public.appointment_waitlist USING btree (company_id, session_id, contact_id) WHERE ((status)::text = 'WAITING'::text);
CREATE INDEX appointment_waitlist_company_id_session_id_status_created_a_idx ON public.appointment_waitlist USING btree (company_id, session_id, status, created_at, id);
CREATE INDEX attendance_company_id_work_date_idx ON public.attendance USING btree (company_id, work_date);
CREATE UNIQUE INDEX attendance_employee_id_work_date_key ON public.attendance USING btree (employee_id, work_date);
CREATE INDEX availability_exceptions_company_id_calendar_id_local_date_idx ON public.availability_exceptions USING btree (company_id, calendar_id, local_date);
CREATE INDEX availability_rules_company_id_calendar_id_weekday_idx ON public.availability_rules USING btree (company_id, calendar_id, weekday);
CREATE UNIQUE INDEX barcode_print_preparations_company_id_actor_id_request_key_key ON public.barcode_print_preparations USING btree (company_id, actor_id, request_key);
CREATE INDEX barcode_print_preparations_company_id_created_at_idx ON public.barcode_print_preparations USING btree (company_id, created_at);
CREATE UNIQUE INDEX booking_session_identity_key ON public.appointment_bookings USING btree (company_id, session_id, id);
CREATE UNIQUE INDEX branches_company_id_code_key ON public.branches USING btree (company_id, code);
CREATE UNIQUE INDEX branches_company_id_id_key ON public.branches USING btree (company_id, id);
CREATE INDEX branches_manager_user_id_idx ON public.branches USING btree (manager_user_id);
CREATE UNIQUE INDEX branches_seq_key ON public.branches USING btree (seq);
CREATE INDEX cash_closure_denominations_cash_closure_id_idx ON public.cash_closure_denominations USING btree (cash_closure_id);
CREATE INDEX cash_closure_payments_cash_closure_id_idx ON public.cash_closure_payments USING btree (cash_closure_id);
CREATE INDEX cash_closure_payments_payment_method_id_idx ON public.cash_closure_payments USING btree (payment_method_id);
CREATE INDEX cash_closures_branch_id_date_idx ON public.cash_closures USING btree (branch_id, date DESC);
CREATE INDEX cash_closures_cashier_id_idx ON public.cash_closures USING btree (cashier_id);
CREATE UNIQUE INDEX cash_closures_closure_number_key ON public.cash_closures USING btree (closure_number);
CREATE INDEX cash_closures_date_idx ON public.cash_closures USING btree (date);
CREATE INDEX cash_closures_status_idx ON public.cash_closures USING btree (status);
CREATE INDEX cash_closures_supervisor_id_idx ON public.cash_closures USING btree (supervisor_id);
CREATE UNIQUE INDEX cash_register_sessions_cash_closure_id_key ON public.cash_register_sessions USING btree (cash_closure_id);
CREATE INDEX cash_register_sessions_cash_register_id_status_idx ON public.cash_register_sessions USING btree (cash_register_id, status);
CREATE UNIQUE INDEX cash_register_sessions_one_open_per_register ON public.cash_register_sessions USING btree (cash_register_id) WHERE (status = 'OPEN'::public."CashRegisterSessionStatus");
CREATE INDEX cash_register_sessions_opened_by_id_idx ON public.cash_register_sessions USING btree (opened_by_id);
CREATE UNIQUE INDEX cash_registers_branch_id_code_key ON public.cash_registers USING btree (branch_id, code);
CREATE UNIQUE INDEX commercial_document_sales_sale_id_key ON public.commercial_document_sales USING btree (sale_id);
CREATE UNIQUE INDEX commercial_documents_branch_id_reference_key ON public.commercial_documents USING btree (branch_id, reference);
CREATE UNIQUE INDEX commercial_documents_public_token_key ON public.commercial_documents USING btree (public_token);
CREATE UNIQUE INDEX commitment_identity_key ON public.payment_commitments USING btree (company_id, branch_id, customer_id, engagement_id, payment_id, id);
CREATE UNIQUE INDEX companies_code_key ON public.companies USING btree (code);
CREATE INDEX company_modules_status_idx ON public.company_modules USING btree (status);
CREATE UNIQUE INDEX customer_payment_refunds_company_id_request_key_key ON public.customer_payment_refunds USING btree (company_id, request_key);
CREATE UNIQUE INDEX customer_payment_refunds_confirmed_key_key ON public.customer_payment_refunds USING btree (confirmed_key);
CREATE INDEX customer_payment_refunds_payment_id_status_idx ON public.customer_payment_refunds USING btree (payment_id, status);
CREATE INDEX customer_payments_branch_id_paid_at_idx ON public.customer_payments USING btree (branch_id, paid_at DESC);
CREATE INDEX customer_payments_cash_register_session_id_idx ON public.customer_payments USING btree (cash_register_session_id);
CREATE INDEX customer_payments_customer_id_paid_at_idx ON public.customer_payments USING btree (customer_id, paid_at DESC);
CREATE INDEX customer_payments_registered_by_idx ON public.customer_payments USING btree (registered_by);
CREATE INDEX customer_price_rules_supplier_id_active_idx ON public.customer_price_rules USING btree (supplier_id, active);
CREATE UNIQUE INDEX document_branch_identity_key ON public.commercial_documents USING btree (branch_id, id);
CREATE UNIQUE INDEX document_line_identity_key ON public.commercial_document_lines USING btree (document_id, id);
CREATE INDEX employee_advances_company_id_status_idx ON public.employee_advances USING btree (company_id, status);
CREATE INDEX employee_advances_employee_id_status_idx ON public.employee_advances USING btree (employee_id, status);
CREATE INDEX employee_document_types_company_id_active_sort_order_idx ON public.employee_document_types USING btree (company_id, active, sort_order);
CREATE INDEX employee_documents_company_id_employee_id_created_at_idx ON public.employee_documents USING btree (company_id, employee_id, created_at);
CREATE UNIQUE INDEX employee_documents_current_type_key ON public.employee_documents USING btree (employee_id, type_id) WHERE (archived_at IS NULL);
CREATE INDEX employee_history_company_id_employee_id_created_at_idx ON public.employee_history USING btree (company_id, employee_id, created_at);
CREATE INDEX employees_branch_id_idx ON public.employees USING btree (branch_id);
CREATE UNIQUE INDEX employees_company_id_code_key ON public.employees USING btree (company_id, code);
CREATE UNIQUE INDEX employees_company_id_creation_request_id_key ON public.employees USING btree (company_id, creation_request_id);
CREATE UNIQUE INDEX employees_company_id_id_key ON public.employees USING btree (company_id, id);
CREATE INDEX employees_status_idx ON public.employees USING btree (status);
CREATE UNIQUE INDEX employees_user_id_key ON public.employees USING btree (user_id);
CREATE UNIQUE INDEX engagement_branch_id_key ON public.appointment_engagements USING btree (branch_id, id);
CREATE UNIQUE INDEX engagement_branch_identity_key ON public.appointment_engagements USING btree (company_id, branch_id, id);
CREATE UNIQUE INDEX engagement_confirmed_origin_identity_key ON public.appointment_engagements USING btree (branch_id, id, sale_id);
CREATE UNIQUE INDEX engagement_customer_identity_key ON public.appointment_engagements USING btree (company_id, branch_id, customer_id, id);
CREATE UNIQUE INDEX engagement_exclusive_session_key ON public.appointment_engagement_schedules USING btree (session_id) WHERE ((kind)::text = ANY ((ARRAY['SESSION'::character varying, 'ACTIVITY'::character varying])::text[]));
CREATE UNIQUE INDEX engagement_history_attempt_key ON public.appointment_engagement_history USING btree (engagement_id, request_key, action);
CREATE UNIQUE INDEX engagement_line_identity_key ON public.appointment_engagement_lines USING btree (company_id, branch_id, engagement_id, id);
CREATE UNIQUE INDEX engagement_order_branch_key ON public.appointment_engagements USING btree (branch_id, order_id);
CREATE UNIQUE INDEX engagement_quote_branch_key ON public.appointment_engagements USING btree (branch_id, quote_id);
CREATE UNIQUE INDEX engagement_quote_identity_key ON public.appointment_engagements USING btree (company_id, branch_id, id, quote_id);
CREATE UNIQUE INDEX engagement_sale_branch_key ON public.appointment_engagements USING btree (branch_id, sale_id);
CREATE INDEX idx_cash_closure_denominations_cash_closure_id ON public.cash_closure_denominations USING btree (cash_closure_id);
CREATE INDEX idx_cash_closure_payments_cash_closure_id ON public.cash_closure_payments USING btree (cash_closure_id);
CREATE INDEX idx_cash_closure_payments_payment_method_id ON public.cash_closure_payments USING btree (payment_method_id);
CREATE INDEX idx_cash_closures_cashier_id ON public.cash_closures USING btree (cashier_id);
CREATE INDEX idx_cash_closures_date ON public.cash_closures USING btree (date);
CREATE INDEX idx_cash_closures_status ON public.cash_closures USING btree (status);
CREATE INDEX idx_cash_closures_supervisor_id ON public.cash_closures USING btree (supervisor_id);
CREATE INDEX idx_commercial_doc_lines_document ON public.commercial_document_lines USING btree (document_id);
CREATE INDEX idx_commercial_doc_lines_product ON public.commercial_document_lines USING btree (product_id);
CREATE INDEX idx_commercial_docs_customer_contact ON public.commercial_documents USING btree (customer_contact_id);
CREATE INDEX idx_commercial_docs_type_status_created ON public.commercial_documents USING btree (doc_type, status, created_at DESC);
CREATE INDEX idx_commercial_document_sales_document ON public.commercial_document_sales USING btree (document_id);
CREATE INDEX idx_incoming_merchandise_date ON public.incoming_merchandise USING btree (date);
CREATE INDEX idx_incoming_merchandise_items_im_id ON public.incoming_merchandise_items USING btree (incoming_merchandise_id);
CREATE INDEX idx_incoming_merchandise_items_product_id ON public.incoming_merchandise_items USING btree (product_id);
CREATE INDEX idx_incoming_merchandise_registered_by ON public.incoming_merchandise USING btree (registered_by);
CREATE INDEX idx_incoming_merchandise_supplier_date ON public.incoming_merchandise USING btree (supplier_id, date DESC);
CREATE INDEX idx_inventory_count_sessions_created_at ON public.inventory_count_sessions USING btree (created_at DESC);
CREATE INDEX idx_inventory_count_sessions_status_created ON public.inventory_count_sessions USING btree (status, created_at DESC);
CREATE INDEX idx_product_bom_lines_component ON public.product_bom_lines USING btree (component_product_id);
CREATE INDEX idx_product_bom_lines_kit ON public.product_bom_lines USING btree (kit_product_id);
CREATE INDEX idx_promotion_codes_code ON public.promotion_codes USING btree (code);
CREATE INDEX idx_promotion_codes_code_active ON public.promotion_codes USING btree (code, active) WHERE (active = true);
CREATE INDEX idx_promotion_codes_promotion_id ON public.promotion_codes USING btree (promotion_id);
CREATE INDEX idx_promotions_active_dates ON public.promotions USING btree (active, start_date, end_date) WHERE (deleted = false);
CREATE INDEX idx_purchase_logs_product_id ON public.purchase_logs USING btree (product_id);
CREATE INDEX idx_purchase_logs_supplier_date ON public.purchase_logs USING btree (supplier_id, date DESC);
CREATE INDEX idx_return_items_product_id ON public.return_items USING btree (product_id);
CREATE INDEX idx_return_items_return_id ON public.return_items USING btree (return_id);
CREATE INDEX idx_return_items_sale_item_id ON public.return_items USING btree (sale_item_id);
CREATE INDEX idx_returns_sale_id ON public.returns USING btree (sale_id);
CREATE INDEX idx_returns_status_id ON public.returns USING btree (status_id);
CREATE INDEX idx_sale_dtes_sale_id ON public.sale_dtes USING btree (sale_id);
CREATE INDEX idx_sale_promotions_promotion_id ON public.sale_promotions USING btree (promotion_id);
CREATE INDEX idx_sale_promotions_sale_id ON public.sale_promotions USING btree (sale_id);
CREATE INDEX idx_sales_created_by ON public.sales USING btree (created_by);
CREATE INDEX idx_sales_customer_lower ON public.sales USING btree (lower((customer)::text)) WHERE (customer IS NOT NULL);
CREATE INDEX idx_sales_customer_nit_lower ON public.sales USING btree (lower((customer_nit)::text)) WHERE (customer_nit IS NOT NULL);
CREATE INDEX idx_sales_customer_nit_trgm ON public.sales USING gin (customer_nit public.gin_trgm_ops) WHERE (customer_nit IS NOT NULL);
CREATE INDEX idx_sales_customer_payment_status_due ON public.sales USING btree (customer_contact_id, payment_status, due_date);
CREATE INDEX idx_sales_customer_trgm ON public.sales USING gin (customer public.gin_trgm_ops) WHERE (customer IS NOT NULL);
CREATE INDEX idx_sales_payment_status_due ON public.sales USING btree (payment_status, due_date);
CREATE INDEX idx_sales_reference_lower ON public.sales USING btree (lower((reference)::text)) WHERE (reference IS NOT NULL);
CREATE INDEX idx_sales_reference_trgm ON public.sales USING gin (reference public.gin_trgm_ops) WHERE (reference IS NOT NULL);
CREATE INDEX idx_sales_status_id_date_desc ON public.sales USING btree (status_id, date DESC);
CREATE INDEX idx_stock_reservations_document_status ON public.stock_reservations USING btree (document_id, status);
CREATE INDEX idx_stock_reservations_product_status ON public.stock_reservations USING btree (product_id, status);
CREATE INDEX idx_suppliers_party_type_name ON public.suppliers USING btree (party_type, name);
CREATE INDEX incoming_merchandise_branch_id_date_idx ON public.incoming_merchandise USING btree (branch_id, date DESC);
CREATE INDEX incoming_merchandise_branch_id_due_date_idx ON public.incoming_merchandise USING btree (branch_id, due_date);
CREATE INDEX incoming_merchandise_date_idx ON public.incoming_merchandise USING btree (date);
CREATE INDEX incoming_merchandise_items_incoming_merchandise_id_idx ON public.incoming_merchandise_items USING btree (incoming_merchandise_id);
CREATE INDEX incoming_merchandise_items_product_id_idx ON public.incoming_merchandise_items USING btree (product_id);
CREATE INDEX incoming_merchandise_payment_entries_incoming_merchandise_i_idx ON public.incoming_merchandise_payment_entries USING btree (incoming_merchandise_id);
CREATE INDEX incoming_merchandise_payment_status_idx ON public.incoming_merchandise USING btree (payment_status);
CREATE INDEX incoming_merchandise_registered_by_idx ON public.incoming_merchandise USING btree (registered_by);
CREATE INDEX inventory_count_lines_product_id_idx ON public.inventory_count_lines USING btree (product_id);
CREATE INDEX inventory_count_lines_session_id_idx ON public.inventory_count_lines USING btree (session_id);
CREATE UNIQUE INDEX inventory_count_lines_session_id_product_id_location_id_key ON public.inventory_count_lines USING btree (session_id, product_id, location_id);
CREATE INDEX inventory_count_sessions_branch_id_idx ON public.inventory_count_sessions USING btree (branch_id);
CREATE INDEX inventory_count_sessions_created_by_id_idx ON public.inventory_count_sessions USING btree (created_by_id);
CREATE INDEX journal_entries_branch_id_idx ON public.journal_entries USING btree (branch_id);
CREATE UNIQUE INDEX journal_entries_company_id_entry_number_key ON public.journal_entries USING btree (company_id, entry_number);
CREATE UNIQUE INDEX journal_entries_company_id_source_type_source_id_key ON public.journal_entries USING btree (company_id, source_type, source_id);
CREATE INDEX journal_entries_date_idx ON public.journal_entries USING btree (date);
CREATE INDEX journal_lines_account_id_idx ON public.journal_lines USING btree (account_id);
CREATE INDEX journal_lines_entry_id_idx ON public.journal_lines USING btree (entry_id);
CREATE INDEX merchandise_payment_audit_events_company_id_created_at_idx ON public.merchandise_payment_audit_events USING btree (company_id, created_at DESC);
CREATE INDEX merchandise_payment_audit_events_incoming_merchandise_id_creat_ ON public.merchandise_payment_audit_events USING btree (incoming_merchandise_id, created_at DESC);
CREATE INDEX order_deliveries_document_id_created_at_idx ON public.order_deliveries USING btree (document_id, created_at);
CREATE INDEX order_delivery_lines_document_line_id_idx ON public.order_delivery_lines USING btree (document_line_id);
CREATE INDEX payment_allocation_events_payment_id_created_at_idx ON public.payment_allocation_events USING btree (payment_id, created_at);
CREATE UNIQUE INDEX payment_commitments_engagement_id_payment_id_key ON public.payment_commitments USING btree (engagement_id, payment_id);
CREATE INDEX payment_commitments_payment_id_state_idx ON public.payment_commitments USING btree (payment_id, state);
CREATE UNIQUE INDEX payment_customer_identity_key ON public.customer_payments USING btree (branch_id, customer_id, id);
CREATE UNIQUE INDEX payment_methods_name_key ON public.payment_methods USING btree (name);
CREATE UNIQUE INDEX payment_terms_company_id_name_key ON public.payment_terms USING btree (company_id, name);
CREATE INDEX payroll_runs_branch_id_status_idx ON public.payroll_runs USING btree (branch_id, status);
CREATE UNIQUE INDEX payroll_runs_company_id_code_key ON public.payroll_runs USING btree (company_id, code);
CREATE INDEX payroll_runs_company_id_pay_date_idx ON public.payroll_runs USING btree (company_id, pay_date);
CREATE INDEX payslip_lines_advance_id_idx ON public.payslip_lines USING btree (advance_id);
CREATE INDEX payslip_lines_payslip_id_idx ON public.payslip_lines USING btree (payslip_id);
CREATE INDEX payslips_employee_id_idx ON public.payslips USING btree (employee_id);
CREATE UNIQUE INDEX payslips_run_id_employee_id_key ON public.payslips USING btree (run_id, employee_id);
CREATE UNIQUE INDEX product_bom_lines_kit_product_id_component_product_id_key ON public.product_bom_lines USING btree (kit_product_id, component_product_id);
CREATE UNIQUE INDEX product_categories_company_id_name_key ON public.product_categories USING btree (company_id, name);
CREATE INDEX product_lots_branch_id_idx ON public.product_lots USING btree (branch_id);
CREATE INDEX product_lots_expiry_date_idx ON public.product_lots USING btree (expiry_date);
CREATE INDEX product_lots_product_id_expiry_date_idx ON public.product_lots USING btree (product_id, expiry_date);
CREATE INDEX product_lots_product_id_location_id_expiry_date_idx ON public.product_lots USING btree (product_id, location_id, expiry_date);
CREATE INDEX product_stock_locations_location_id_idx ON public.product_stock_locations USING btree (location_id);
CREATE UNIQUE INDEX product_stock_locations_product_id_location_id_key ON public.product_stock_locations USING btree (product_id, location_id);
CREATE INDEX product_stocks_branch_id_idx ON public.product_stocks USING btree (branch_id);
CREATE UNIQUE INDEX product_stocks_product_id_branch_id_key ON public.product_stocks USING btree (product_id, branch_id);
CREATE UNIQUE INDEX products_company_id_barcode_key ON public.products USING btree (company_id, barcode);
CREATE UNIQUE INDEX products_company_id_id_key ON public.products USING btree (company_id, id);
CREATE INDEX products_company_id_idx ON public.products USING btree (company_id);
CREATE INDEX promotion_branches_branch_id_idx ON public.promotion_branches USING btree (branch_id);
CREATE UNIQUE INDEX promotion_categories_promotion_id_category_id_key ON public.promotion_categories USING btree (promotion_id, category_id);
CREATE UNIQUE INDEX promotion_codes_company_id_code_key ON public.promotion_codes USING btree (company_id, code);
CREATE INDEX promotion_codes_promotion_id_idx ON public.promotion_codes USING btree (promotion_id);
CREATE INDEX promotion_coupon_assets_company_id_promotion_id_idx ON public.promotion_coupon_assets USING btree (company_id, promotion_id);
CREATE INDEX promotion_coupon_assets_status_expires_at_idx ON public.promotion_coupon_assets USING btree (status, expires_at);
CREATE UNIQUE INDEX promotion_products_promotion_id_product_id_key ON public.promotion_products USING btree (promotion_id, product_id);
CREATE UNIQUE INDEX promotion_types_name_key ON public.promotion_types USING btree (name);
CREATE INDEX promotions_active_start_date_end_date_idx ON public.promotions USING btree (active, start_date, end_date);
CREATE INDEX promotions_company_id_idx ON public.promotions USING btree (company_id);
CREATE INDEX purchase_logs_product_id_idx ON public.purchase_logs USING btree (product_id);
CREATE UNIQUE INDEX refresh_tokens_token_hash_key ON public.refresh_tokens USING btree (token_hash);
CREATE INDEX refresh_tokens_user_id_idx ON public.refresh_tokens USING btree (user_id);
CREATE INDEX return_items_product_id_idx ON public.return_items USING btree (product_id);
CREATE INDEX return_items_return_id_idx ON public.return_items USING btree (return_id);
CREATE INDEX return_items_sale_item_id_idx ON public.return_items USING btree (sale_item_id);
CREATE INDEX return_items_stock_location_id_idx ON public.return_items USING btree (stock_location_id);
CREATE INDEX return_replacement_items_product_id_idx ON public.return_replacement_items USING btree (product_id);
CREATE INDEX return_replacement_items_return_id_idx ON public.return_replacement_items USING btree (return_id);
CREATE INDEX return_settlements_cash_register_session_id_idx ON public.return_settlements USING btree (cash_register_session_id);
CREATE INDEX return_settlements_return_id_created_at_idx ON public.return_settlements USING btree (return_id, created_at);
CREATE UNIQUE INDEX return_settlements_return_id_idempotency_key_key ON public.return_settlements USING btree (return_id, idempotency_key);
CREATE UNIQUE INDEX returns_reference_key ON public.returns USING btree (reference);
CREATE UNIQUE INDEX returns_replacement_sale_id_key ON public.returns USING btree (replacement_sale_id);
CREATE INDEX returns_sale_id_idx ON public.returns USING btree (sale_id);
CREATE INDEX returns_status_id_idx ON public.returns USING btree (status_id);
CREATE UNIQUE INDEX roles_company_legacy_key ON public.roles USING btree (company_id, legacy_role_id);
CREATE UNIQUE INDEX roles_company_name_key ON public.roles USING btree (company_id, name_key);
CREATE UNIQUE INDEX roles_system_key_key ON public.roles USING btree (system_key);
CREATE UNIQUE INDEX sale_branch_identity_key ON public.sales USING btree (branch_id, id);
CREATE UNIQUE INDEX sale_dte_company_authorization_key ON public.sale_dtes USING btree (company_id, lower(btrim(("authorization")::text))) WHERE (NULLIF(btrim(("authorization")::text), ''::text) IS NOT NULL);
CREATE INDEX sale_dtes_sale_id_idx ON public.sale_dtes USING btree (sale_id);
CREATE UNIQUE INDEX sale_history_request_key ON public.sale_history USING btree (company_id, actor_id, action, request_key);
CREATE INDEX sale_history_sale_id_created_at_idx ON public.sale_history USING btree (sale_id, created_at);
CREATE UNIQUE INDEX sale_origin_branch_key ON public.sales USING btree (branch_id, origin_engagement_id);
CREATE UNIQUE INDEX sale_origin_engagement_key ON public.sales USING btree (origin_engagement_id);
CREATE UNIQUE INDEX sale_origin_identity_key ON public.sales USING btree (branch_id, origin_engagement_id, id);
CREATE INDEX sale_payment_entries_customer_payment_id_idx ON public.sale_payment_entries USING btree (customer_payment_id);
CREATE INDEX sale_payment_entries_sale_id_idx ON public.sale_payment_entries USING btree (sale_id);
CREATE INDEX sale_promotions_promotion_id_idx ON public.sale_promotions USING btree (promotion_id);
CREATE INDEX sale_promotions_sale_id_idx ON public.sale_promotions USING btree (sale_id);
CREATE UNIQUE INDEX sale_statuses_name_key ON public.sale_statuses USING btree (name);
CREATE INDEX sales_branch_id_date_idx ON public.sales USING btree (branch_id, date DESC);
CREATE UNIQUE INDEX sales_branch_id_idempotency_key_key ON public.sales USING btree (branch_id, idempotency_key);
CREATE UNIQUE INDEX sales_branch_id_reference_key ON public.sales USING btree (branch_id, reference);
CREATE INDEX sales_cash_register_session_id_idx ON public.sales USING btree (cash_register_session_id);
CREATE INDEX sales_created_by_idx ON public.sales USING btree (created_by);
CREATE UNIQUE INDEX schedule_calendars_branch_id_key ON public.schedule_calendars USING btree (branch_id);
CREATE UNIQUE INDEX schedule_calendars_company_id_id_key ON public.schedule_calendars USING btree (company_id, id);
CREATE UNIQUE INDEX schedule_calendars_provider_id_key ON public.schedule_calendars USING btree (provider_id);
CREATE UNIQUE INDEX schedule_calendars_resource_id_key ON public.schedule_calendars USING btree (resource_id);
CREATE INDEX schedule_resources_company_id_branch_id_active_idx ON public.schedule_resources USING btree (company_id, branch_id, active);
CREATE UNIQUE INDEX schedule_resources_company_id_id_key ON public.schedule_resources USING btree (company_id, id);
CREATE INDEX service_provider_branches_company_id_branch_id_idx ON public.service_provider_branches USING btree (company_id, branch_id);
CREATE INDEX service_providers_company_id_active_idx ON public.service_providers USING btree (company_id, active);
CREATE UNIQUE INDEX service_providers_company_id_employee_id_key ON public.service_providers USING btree (company_id, employee_id);
CREATE UNIQUE INDEX service_providers_company_id_id_key ON public.service_providers USING btree (company_id, id);
CREATE UNIQUE INDEX service_providers_company_id_user_id_key ON public.service_providers USING btree (company_id, user_id);
CREATE UNIQUE INDEX service_providers_employee_id_key ON public.service_providers USING btree (employee_id);
CREATE INDEX service_schedule_branches_company_id_branch_id_idx ON public.service_schedule_branches USING btree (company_id, branch_id);
CREATE INDEX service_schedule_profiles_company_id_enabled_idx ON public.service_schedule_profiles USING btree (company_id, enabled);
CREATE UNIQUE INDEX service_schedule_profiles_company_id_id_key ON public.service_schedule_profiles USING btree (company_id, id);
CREATE UNIQUE INDEX service_schedule_profiles_company_id_product_id_key ON public.service_schedule_profiles USING btree (company_id, product_id);
CREATE UNIQUE INDEX service_schedule_profiles_product_id_key ON public.service_schedule_profiles USING btree (product_id);
CREATE INDEX service_schedule_providers_company_id_provider_id_idx ON public.service_schedule_providers USING btree (company_id, provider_id);
CREATE INDEX service_schedule_resources_company_id_resource_id_idx ON public.service_schedule_resources USING btree (company_id, resource_id);
CREATE UNIQUE INDEX statuses_name_key ON public.statuses USING btree (name);
CREATE INDEX stock_locations_warehouse_id_active_idx ON public.stock_locations USING btree (warehouse_id, active);
CREATE UNIQUE INDEX stock_locations_warehouse_id_code_key ON public.stock_locations USING btree (warehouse_id, code);
CREATE INDEX stock_movements_branch_id_created_at_idx ON public.stock_movements USING btree (branch_id, created_at DESC);
CREATE INDEX stock_movements_group_id_idx ON public.stock_movements USING btree (group_id);
CREATE INDEX stock_movements_location_id_created_at_idx ON public.stock_movements USING btree (location_id, created_at DESC);
CREATE INDEX stock_movements_product_id_created_at_idx ON public.stock_movements USING btree (product_id, created_at DESC);
CREATE INDEX stock_movements_ref_type_ref_id_idx ON public.stock_movements USING btree (ref_type, ref_id);
CREATE INDEX stock_reservations_branch_id_product_id_status_idx ON public.stock_reservations USING btree (branch_id, product_id, status);
CREATE UNIQUE INDEX stock_statuses_name_key ON public.stock_statuses USING btree (name);
CREATE INDEX stock_transfer_lines_product_id_idx ON public.stock_transfer_lines USING btree (product_id);
CREATE INDEX stock_transfer_lines_transfer_id_idx ON public.stock_transfer_lines USING btree (transfer_id);
CREATE UNIQUE INDEX stock_transfers_from_branch_id_reference_key ON public.stock_transfers USING btree (from_branch_id, reference);
CREATE INDEX stock_transfers_from_branch_id_status_idx ON public.stock_transfers USING btree (from_branch_id, status);
CREATE INDEX stock_transfers_to_branch_id_status_idx ON public.stock_transfers USING btree (to_branch_id, status);
CREATE INDEX supplier_payment_terms_payment_term_id_idx ON public.supplier_payment_terms USING btree (payment_term_id);
CREATE INDEX supplier_payments_branch_id_paid_at_idx ON public.supplier_payments USING btree (branch_id, paid_at DESC);
CREATE INDEX supplier_payments_company_id_supplier_id_paid_at_idx ON public.supplier_payments USING btree (company_id, supplier_id, paid_at DESC);
CREATE UNIQUE INDEX suppliers_company_id_id_key ON public.suppliers USING btree (company_id, id);
CREATE INDEX suppliers_company_id_party_type_idx ON public.suppliers USING btree (company_id, party_type);
CREATE UNIQUE INDEX system_settings_company_id_key_key ON public.system_settings USING btree (company_id, key);
CREATE INDEX user_access_events_company_id_user_id_created_at_idx ON public.user_access_events USING btree (company_id, user_id, created_at);
CREATE INDEX user_branches_branch_id_idx ON public.user_branches USING btree (branch_id);
CREATE INDEX user_companies_company_id_idx ON public.user_companies USING btree (company_id);
CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email);
CREATE INDEX warehouses_branch_id_active_idx ON public.warehouses USING btree (branch_id, active);
CREATE UNIQUE INDEX warehouses_branch_id_code_key ON public.warehouses USING btree (branch_id, code);
CREATE TRIGGER commercial_document_lines_snapshot BEFORE INSERT ON public.commercial_document_lines FOR EACH ROW EXECUTE FUNCTION public.capture_commercial_item_snapshot();
CREATE TRIGGER confirmed_sale_payment_method_guard BEFORE INSERT OR UPDATE OF payment_method_id, status_id ON public.sales FOR EACH ROW EXECUTE FUNCTION public.guard_confirmed_sale_payment_method();
CREATE TRIGGER return_replacement_items_snapshot BEFORE INSERT ON public.return_replacement_items FOR EACH ROW EXECUTE FUNCTION public.capture_commercial_item_snapshot();
CREATE TRIGGER sale_items_snapshot BEFORE INSERT ON public.sale_items FOR EACH ROW EXECUTE FUNCTION public.capture_commercial_item_snapshot();
ALTER TABLE ONLY public.accounting_periods
    ADD CONSTRAINT accounting_periods_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.accounting_periods
    ADD CONSTRAINT accounting_periods_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_priority_id_fkey FOREIGN KEY (priority_id) REFERENCES public.alert_priorities(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_status_id_fkey FOREIGN KEY (status_id) REFERENCES public.statuses(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.alert_types(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.payment_allocation_events
    ADD CONSTRAINT allocation_commitment_fkey FOREIGN KEY (company_id, branch_id, customer_id, engagement_id, payment_id, commitment_id) REFERENCES public.payment_commitments(company_id, branch_id, customer_id, engagement_id, payment_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_bookings
    ADD CONSTRAINT appointment_booking_session_type_fkey FOREIGN KEY (company_id, branch_id, session_id, session_type) REFERENCES public.appointment_sessions(company_id, branch_id, id, record_type) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_bookings
    ADD CONSTRAINT appointment_bookings_company_id_branch_id_fkey FOREIGN KEY (company_id, branch_id) REFERENCES public.branches(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_bookings
    ADD CONSTRAINT appointment_bookings_company_id_branch_id_session_id_fkey FOREIGN KEY (company_id, branch_id, session_id) REFERENCES public.appointment_sessions(company_id, branch_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_bookings
    ADD CONSTRAINT appointment_bookings_company_id_contact_id_fkey FOREIGN KEY (company_id, contact_id) REFERENCES public.suppliers(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_bookings
    ADD CONSTRAINT appointment_bookings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_bookings
    ADD CONSTRAINT appointment_bookings_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_engagement_history
    ADD CONSTRAINT appointment_engagement_history_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_engagement_history
    ADD CONSTRAINT appointment_engagement_history_company_id_branch_id_custom_fkey FOREIGN KEY (company_id, branch_id, customer_id, engagement_id) REFERENCES public.appointment_engagements(company_id, branch_id, customer_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_engagement_lines
    ADD CONSTRAINT appointment_engagement_lines_company_id_branch_id_engageme_fkey FOREIGN KEY (company_id, branch_id, engagement_id) REFERENCES public.appointment_engagements(company_id, branch_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_engagement_lines
    ADD CONSTRAINT appointment_engagement_lines_company_id_product_id_fkey FOREIGN KEY (company_id, product_id) REFERENCES public.products(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_engagement_lines
    ADD CONSTRAINT appointment_engagement_lines_source_document_id_source_lin_fkey FOREIGN KEY (source_document_id, source_line_id) REFERENCES public.commercial_document_lines(document_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_engagement_schedules
    ADD CONSTRAINT appointment_engagement_schedules_company_id_branch_id_enga_fkey FOREIGN KEY (company_id, branch_id, engagement_id, line_id) REFERENCES public.appointment_engagement_lines(company_id, branch_id, engagement_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_engagement_schedules
    ADD CONSTRAINT appointment_engagement_schedules_company_id_branch_id_sess_fkey FOREIGN KEY (company_id, branch_id, session_id, session_type) REFERENCES public.appointment_sessions(company_id, branch_id, id, record_type) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_engagement_schedules
    ADD CONSTRAINT appointment_engagement_schedules_company_id_session_id_boo_fkey FOREIGN KEY (company_id, session_id, booking_id) REFERENCES public.appointment_bookings(company_id, session_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_engagements
    ADD CONSTRAINT appointment_engagements_branch_id_order_id_fkey FOREIGN KEY (branch_id, order_id) REFERENCES public.commercial_documents(branch_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_engagements
    ADD CONSTRAINT appointment_engagements_branch_id_quote_id_fkey FOREIGN KEY (branch_id, quote_id) REFERENCES public.commercial_documents(branch_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_engagements
    ADD CONSTRAINT appointment_engagements_branch_id_sale_id_fkey FOREIGN KEY (branch_id, sale_id) REFERENCES public.sales(branch_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_engagements
    ADD CONSTRAINT appointment_engagements_company_id_branch_id_fkey FOREIGN KEY (company_id, branch_id) REFERENCES public.branches(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_engagements
    ADD CONSTRAINT appointment_engagements_company_id_customer_id_fkey FOREIGN KEY (company_id, customer_id) REFERENCES public.suppliers(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_engagements
    ADD CONSTRAINT appointment_engagements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_history
    ADD CONSTRAINT appointment_history_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_history
    ADD CONSTRAINT appointment_history_company_id_booking_id_fkey FOREIGN KEY (company_id, booking_id) REFERENCES public.appointment_bookings(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_history
    ADD CONSTRAINT appointment_history_company_id_branch_id_fkey FOREIGN KEY (company_id, branch_id) REFERENCES public.branches(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_history
    ADD CONSTRAINT appointment_history_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_history
    ADD CONSTRAINT appointment_history_company_id_session_id_fkey FOREIGN KEY (company_id, session_id) REFERENCES public.appointment_sessions(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_participants
    ADD CONSTRAINT appointment_participants_company_id_contact_id_fkey FOREIGN KEY (company_id, contact_id) REFERENCES public.suppliers(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_participants
    ADD CONSTRAINT appointment_participants_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_participants
    ADD CONSTRAINT appointment_participants_company_id_session_id_session_type_fke FOREIGN KEY (company_id, session_id, session_type) REFERENCES public.appointment_sessions(company_id, id, record_type) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_participants
    ADD CONSTRAINT appointment_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_requests
    ADD CONSTRAINT appointment_requests_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_requests
    ADD CONSTRAINT appointment_requests_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_session_providers
    ADD CONSTRAINT appointment_session_providers_company_id_provider_id_fkey FOREIGN KEY (company_id, provider_id) REFERENCES public.service_providers(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_session_providers
    ADD CONSTRAINT appointment_session_providers_company_id_session_id_fkey FOREIGN KEY (company_id, session_id) REFERENCES public.appointment_sessions(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_session_resources
    ADD CONSTRAINT appointment_session_resources_company_id_resource_id_fkey FOREIGN KEY (company_id, resource_id) REFERENCES public.schedule_resources(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_session_resources
    ADD CONSTRAINT appointment_session_resources_company_id_session_id_fkey FOREIGN KEY (company_id, session_id) REFERENCES public.appointment_sessions(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_sessions
    ADD CONSTRAINT appointment_sessions_company_id_branch_id_fkey FOREIGN KEY (company_id, branch_id) REFERENCES public.branches(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_sessions
    ADD CONSTRAINT appointment_sessions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_sessions
    ADD CONSTRAINT appointment_sessions_company_id_product_id_fkey FOREIGN KEY (company_id, product_id) REFERENCES public.products(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_sessions
    ADD CONSTRAINT appointment_sessions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_sessions
    ADD CONSTRAINT appointment_sessions_organizer_id_fkey FOREIGN KEY (organizer_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_waitlist
    ADD CONSTRAINT appointment_waitlist_company_id_booking_id_fkey FOREIGN KEY (company_id, booking_id) REFERENCES public.appointment_bookings(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_waitlist
    ADD CONSTRAINT appointment_waitlist_company_id_contact_id_fkey FOREIGN KEY (company_id, contact_id) REFERENCES public.suppliers(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_waitlist
    ADD CONSTRAINT appointment_waitlist_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_waitlist
    ADD CONSTRAINT appointment_waitlist_company_id_session_id_fkey FOREIGN KEY (company_id, session_id) REFERENCES public.appointment_sessions(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_waitlist
    ADD CONSTRAINT appointment_waitlist_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_waitlist
    ADD CONSTRAINT appointment_waitlist_session_type_fkey FOREIGN KEY (company_id, session_id, session_type) REFERENCES public.appointment_sessions(company_id, id, record_type) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.attendance
    ADD CONSTRAINT attendance_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.attendance
    ADD CONSTRAINT attendance_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.attendance
    ADD CONSTRAINT attendance_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.availability_exceptions
    ADD CONSTRAINT availability_exceptions_company_id_calendar_id_fkey FOREIGN KEY (company_id, calendar_id) REFERENCES public.schedule_calendars(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.availability_rules
    ADD CONSTRAINT availability_rules_company_id_calendar_id_fkey FOREIGN KEY (company_id, calendar_id) REFERENCES public.schedule_calendars(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.barcode_print_preparations
    ADD CONSTRAINT barcode_print_preparations_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.barcode_print_preparations
    ADD CONSTRAINT barcode_print_preparations_company_id_branch_id_fkey FOREIGN KEY (company_id, branch_id) REFERENCES public.branches(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.barcode_print_preparations
    ADD CONSTRAINT barcode_print_preparations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_manager_user_id_fkey FOREIGN KEY (manager_user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_sales_location_id_fkey FOREIGN KEY (sales_location_id) REFERENCES public.stock_locations(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.cash_closure_denominations
    ADD CONSTRAINT cash_closure_denominations_cash_closure_id_fkey FOREIGN KEY (cash_closure_id) REFERENCES public.cash_closures(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.cash_closure_payments
    ADD CONSTRAINT cash_closure_payments_cash_closure_id_fkey FOREIGN KEY (cash_closure_id) REFERENCES public.cash_closures(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.cash_closure_payments
    ADD CONSTRAINT cash_closure_payments_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES public.payment_methods(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.cash_closures
    ADD CONSTRAINT cash_closures_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.cash_closures
    ADD CONSTRAINT cash_closures_cashier_id_fkey FOREIGN KEY (cashier_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.cash_closures
    ADD CONSTRAINT cash_closures_supervisor_id_fkey FOREIGN KEY (supervisor_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.cash_register_sessions
    ADD CONSTRAINT cash_register_sessions_cash_closure_id_fkey FOREIGN KEY (cash_closure_id) REFERENCES public.cash_closures(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.cash_register_sessions
    ADD CONSTRAINT cash_register_sessions_cash_register_id_fkey FOREIGN KEY (cash_register_id) REFERENCES public.cash_registers(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.cash_register_sessions
    ADD CONSTRAINT cash_register_sessions_closed_by_id_fkey FOREIGN KEY (closed_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.cash_register_sessions
    ADD CONSTRAINT cash_register_sessions_opened_by_id_fkey FOREIGN KEY (opened_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.cash_registers
    ADD CONSTRAINT cash_registers_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.commercial_document_lines
    ADD CONSTRAINT commercial_document_lines_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.commercial_documents(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.commercial_document_lines
    ADD CONSTRAINT commercial_document_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.commercial_document_sales
    ADD CONSTRAINT commercial_document_sales_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.commercial_documents(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.commercial_document_sales
    ADD CONSTRAINT commercial_document_sales_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.commercial_documents
    ADD CONSTRAINT commercial_documents_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.commercial_documents
    ADD CONSTRAINT commercial_documents_converted_from_id_fkey FOREIGN KEY (converted_from_id) REFERENCES public.commercial_documents(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.commercial_documents
    ADD CONSTRAINT commercial_documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.commercial_documents
    ADD CONSTRAINT commercial_documents_customer_contact_id_fkey FOREIGN KEY (customer_contact_id) REFERENCES public.suppliers(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.company_modules
    ADD CONSTRAINT company_modules_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.customer_payment_refunds
    ADD CONSTRAINT customer_payment_refunds_branch_id_customer_id_payment_id_fkey FOREIGN KEY (branch_id, customer_id, payment_id) REFERENCES public.customer_payments(branch_id, customer_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.customer_payment_refunds
    ADD CONSTRAINT customer_payment_refunds_cash_register_session_id_fkey FOREIGN KEY (cash_register_session_id) REFERENCES public.cash_register_sessions(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.customer_payment_refunds
    ADD CONSTRAINT customer_payment_refunds_company_id_branch_id_customer_id__fkey FOREIGN KEY (company_id, branch_id, customer_id, engagement_id) REFERENCES public.appointment_engagements(company_id, branch_id, customer_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.customer_payment_refunds
    ADD CONSTRAINT customer_payment_refunds_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES public.payment_methods(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.customer_payment_refunds
    ADD CONSTRAINT customer_payment_refunds_registered_by_fkey FOREIGN KEY (registered_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.customer_payments
    ADD CONSTRAINT customer_payments_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.customer_payments
    ADD CONSTRAINT customer_payments_cash_register_session_id_fkey FOREIGN KEY (cash_register_session_id) REFERENCES public.cash_register_sessions(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.customer_payments
    ADD CONSTRAINT customer_payments_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.customer_payments
    ADD CONSTRAINT customer_payments_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES public.payment_methods(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.customer_payments
    ADD CONSTRAINT customer_payments_registered_by_fkey FOREIGN KEY (registered_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.customer_price_rules
    ADD CONSTRAINT customer_price_rules_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.employee_advances
    ADD CONSTRAINT employee_advances_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.employee_advances
    ADD CONSTRAINT employee_advances_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.employee_advances
    ADD CONSTRAINT employee_advances_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.employee_advances
    ADD CONSTRAINT employee_advances_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.employee_document_types
    ADD CONSTRAINT employee_document_types_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.employee_document_types(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.employee_history
    ADD CONSTRAINT employee_history_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.employee_history
    ADD CONSTRAINT employee_history_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.employee_history
    ADD CONSTRAINT employee_history_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_supervisor_id_fkey FOREIGN KEY (supervisor_id) REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.appointment_engagements
    ADD CONSTRAINT engagement_confirmed_sale_origin_fk FOREIGN KEY (branch_id, id, sale_id) REFERENCES public.sales(branch_id, origin_engagement_id, id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.appointment_engagement_lines
    ADD CONSTRAINT engagement_line_quote_fkey FOREIGN KEY (company_id, branch_id, engagement_id, source_document_id) REFERENCES public.appointment_engagements(company_id, branch_id, id, quote_id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.incoming_merchandise
    ADD CONSTRAINT incoming_merchandise_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.incoming_merchandise_items
    ADD CONSTRAINT incoming_merchandise_items_incoming_merchandise_id_fkey FOREIGN KEY (incoming_merchandise_id) REFERENCES public.incoming_merchandise(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.incoming_merchandise_items
    ADD CONSTRAINT incoming_merchandise_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.incoming_merchandise_payment_entries
    ADD CONSTRAINT incoming_merchandise_payment_entries_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.incoming_merchandise_payment_entries
    ADD CONSTRAINT incoming_merchandise_payment_entries_incoming_merchandise__fkey FOREIGN KEY (incoming_merchandise_id) REFERENCES public.incoming_merchandise(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.incoming_merchandise_payment_entries
    ADD CONSTRAINT incoming_merchandise_payment_entries_registered_by_fkey FOREIGN KEY (registered_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.incoming_merchandise_payment_entries
    ADD CONSTRAINT incoming_merchandise_payment_entries_supplier_payment_id_fkey FOREIGN KEY (supplier_payment_id) REFERENCES public.supplier_payments(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.incoming_merchandise
    ADD CONSTRAINT incoming_merchandise_payment_term_id_fkey FOREIGN KEY (payment_term_id) REFERENCES public.payment_terms(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.incoming_merchandise
    ADD CONSTRAINT incoming_merchandise_payment_updated_by_fkey FOREIGN KEY (payment_updated_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.incoming_merchandise
    ADD CONSTRAINT incoming_merchandise_registered_by_fkey FOREIGN KEY (registered_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.incoming_merchandise
    ADD CONSTRAINT incoming_merchandise_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.inventory_count_lines
    ADD CONSTRAINT inventory_count_lines_counted_by_id_fkey FOREIGN KEY (counted_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.inventory_count_lines
    ADD CONSTRAINT inventory_count_lines_counted_secondary_by_id_fkey FOREIGN KEY (counted_secondary_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.inventory_count_lines
    ADD CONSTRAINT inventory_count_lines_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.stock_locations(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.inventory_count_lines
    ADD CONSTRAINT inventory_count_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.inventory_count_lines
    ADD CONSTRAINT inventory_count_lines_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.inventory_count_sessions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.inventory_count_sessions
    ADD CONSTRAINT inventory_count_sessions_approved_by_id_fkey FOREIGN KEY (approved_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.inventory_count_sessions
    ADD CONSTRAINT inventory_count_sessions_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.inventory_count_sessions
    ADD CONSTRAINT inventory_count_sessions_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.inventory_count_sessions
    ADD CONSTRAINT inventory_count_sessions_first_approved_by_id_fkey FOREIGN KEY (first_approved_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.inventory_count_sessions
    ADD CONSTRAINT inventory_count_sessions_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_reversal_of_id_fkey FOREIGN KEY (reversal_of_id) REFERENCES public.journal_entries(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.journal_lines
    ADD CONSTRAINT journal_lines_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.journal_lines
    ADD CONSTRAINT journal_lines_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.journal_entries(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.merchandise_payment_audit_events
    ADD CONSTRAINT merchandise_payment_audit_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.merchandise_payment_audit_events
    ADD CONSTRAINT merchandise_payment_audit_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.merchandise_payment_audit_events
    ADD CONSTRAINT merchandise_payment_audit_events_incoming_merchandise_id_fkey FOREIGN KEY (incoming_merchandise_id) REFERENCES public.incoming_merchandise(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.order_deliveries
    ADD CONSTRAINT order_deliveries_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.commercial_documents(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.order_delivery_lines
    ADD CONSTRAINT order_delivery_lines_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES public.order_deliveries(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.order_delivery_lines
    ADD CONSTRAINT order_delivery_lines_document_line_id_fkey FOREIGN KEY (document_line_id) REFERENCES public.commercial_document_lines(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.payment_allocation_events
    ADD CONSTRAINT payment_allocation_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.payment_allocation_events
    ADD CONSTRAINT payment_allocation_events_branch_id_customer_id_payment_id_fkey FOREIGN KEY (branch_id, customer_id, payment_id) REFERENCES public.customer_payments(branch_id, customer_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.payment_allocation_events
    ADD CONSTRAINT payment_allocation_events_company_id_branch_id_customer_id_fkey FOREIGN KEY (company_id, branch_id, customer_id, engagement_id) REFERENCES public.appointment_engagements(company_id, branch_id, customer_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.payment_allocation_events
    ADD CONSTRAINT payment_allocation_events_return_settlement_id_fkey FOREIGN KEY (return_settlement_id) REFERENCES public.return_settlements(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.payment_commitments
    ADD CONSTRAINT payment_commitments_branch_id_customer_id_payment_id_fkey FOREIGN KEY (branch_id, customer_id, payment_id) REFERENCES public.customer_payments(branch_id, customer_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.payment_commitments
    ADD CONSTRAINT payment_commitments_company_id_branch_id_customer_id_engag_fkey FOREIGN KEY (company_id, branch_id, customer_id, engagement_id) REFERENCES public.appointment_engagements(company_id, branch_id, customer_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.payment_terms
    ADD CONSTRAINT payment_terms_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.payslip_lines
    ADD CONSTRAINT payslip_lines_advance_id_fkey FOREIGN KEY (advance_id) REFERENCES public.employee_advances(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.payslip_lines
    ADD CONSTRAINT payslip_lines_payslip_id_fkey FOREIGN KEY (payslip_id) REFERENCES public.payslips(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT payslips_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT payslips_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.payroll_runs(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.product_bom_lines
    ADD CONSTRAINT product_bom_lines_component_product_id_fkey FOREIGN KEY (component_product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.product_bom_lines
    ADD CONSTRAINT product_bom_lines_kit_product_id_fkey FOREIGN KEY (kit_product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.product_categories
    ADD CONSTRAINT product_categories_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.product_lots
    ADD CONSTRAINT product_lots_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.product_lots
    ADD CONSTRAINT product_lots_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.stock_locations(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.product_lots
    ADD CONSTRAINT product_lots_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.product_stock_locations
    ADD CONSTRAINT product_stock_locations_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.stock_locations(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.product_stock_locations
    ADD CONSTRAINT product_stock_locations_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.product_stocks
    ADD CONSTRAINT product_stocks_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.product_stocks
    ADD CONSTRAINT product_stocks_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.product_categories(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_status_id_fkey FOREIGN KEY (status_id) REFERENCES public.stock_statuses(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.promotion_branches
    ADD CONSTRAINT promotion_branches_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.promotion_branches
    ADD CONSTRAINT promotion_branches_promotion_id_fkey FOREIGN KEY (promotion_id) REFERENCES public.promotions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.promotion_categories
    ADD CONSTRAINT promotion_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.product_categories(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.promotion_categories
    ADD CONSTRAINT promotion_categories_promotion_id_fkey FOREIGN KEY (promotion_id) REFERENCES public.promotions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.promotion_codes
    ADD CONSTRAINT promotion_codes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.promotion_codes
    ADD CONSTRAINT promotion_codes_promotion_id_fkey FOREIGN KEY (promotion_id) REFERENCES public.promotions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.promotion_coupon_assets
    ADD CONSTRAINT promotion_coupon_assets_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.promotion_coupon_assets
    ADD CONSTRAINT promotion_coupon_assets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.promotion_coupon_assets
    ADD CONSTRAINT promotion_coupon_assets_promotion_id_fkey FOREIGN KEY (promotion_id) REFERENCES public.promotions(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.promotion_products
    ADD CONSTRAINT promotion_products_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.promotion_products
    ADD CONSTRAINT promotion_products_promotion_id_fkey FOREIGN KEY (promotion_id) REFERENCES public.promotions(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.promotions
    ADD CONSTRAINT promotions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.promotions
    ADD CONSTRAINT promotions_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.promotion_types(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.purchase_logs
    ADD CONSTRAINT purchase_logs_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.purchase_logs
    ADD CONSTRAINT purchase_logs_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.return_items
    ADD CONSTRAINT return_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.return_items
    ADD CONSTRAINT return_items_return_id_fkey FOREIGN KEY (return_id) REFERENCES public.returns(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.return_items
    ADD CONSTRAINT return_items_sale_item_id_fkey FOREIGN KEY (sale_item_id) REFERENCES public.sale_items(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.return_items
    ADD CONSTRAINT return_items_stock_location_id_fkey FOREIGN KEY (stock_location_id) REFERENCES public.stock_locations(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.return_replacement_items
    ADD CONSTRAINT return_replacement_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.return_replacement_items
    ADD CONSTRAINT return_replacement_items_return_id_fkey FOREIGN KEY (return_id) REFERENCES public.returns(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.return_settlements
    ADD CONSTRAINT return_settlements_cash_register_session_id_fkey FOREIGN KEY (cash_register_session_id) REFERENCES public.cash_register_sessions(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.return_settlements
    ADD CONSTRAINT return_settlements_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES public.payment_methods(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.return_settlements
    ADD CONSTRAINT return_settlements_return_id_fkey FOREIGN KEY (return_id) REFERENCES public.returns(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.returns
    ADD CONSTRAINT returns_replacement_sale_id_fkey FOREIGN KEY (replacement_sale_id) REFERENCES public.sales(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.returns
    ADD CONSTRAINT returns_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.returns
    ADD CONSTRAINT returns_status_id_fkey FOREIGN KEY (status_id) REFERENCES public.return_statuses(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_legacy_role_id_fkey FOREIGN KEY (legacy_role_id) REFERENCES public.roles(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.sale_dtes
    ADD CONSTRAINT sale_dte_company_branch_fk FOREIGN KEY (company_id, branch_id) REFERENCES public.branches(company_id, id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.sale_dtes
    ADD CONSTRAINT sale_dte_sale_branch_fk FOREIGN KEY (branch_id, sale_id) REFERENCES public.sales(branch_id, id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.sale_dtes
    ADD CONSTRAINT sale_dtes_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.sale_history
    ADD CONSTRAINT sale_history_actor_fk FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.sale_history
    ADD CONSTRAINT sale_history_company_branch_fk FOREIGN KEY (company_id, branch_id) REFERENCES public.branches(company_id, id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.sale_history
    ADD CONSTRAINT sale_history_sale_branch_fk FOREIGN KEY (branch_id, sale_id) REFERENCES public.sales(branch_id, id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sale_origin_branch_fk FOREIGN KEY (branch_id, origin_engagement_id) REFERENCES public.appointment_engagements(branch_id, id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.sale_payment_entries
    ADD CONSTRAINT sale_payment_entries_customer_payment_id_fkey FOREIGN KEY (customer_payment_id) REFERENCES public.customer_payments(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.sale_payment_entries
    ADD CONSTRAINT sale_payment_entries_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.sale_promotions
    ADD CONSTRAINT sale_promotions_promotion_id_fkey FOREIGN KEY (promotion_id) REFERENCES public.promotions(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.sale_promotions
    ADD CONSTRAINT sale_promotions_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_cash_register_session_id_fkey FOREIGN KEY (cash_register_session_id) REFERENCES public.cash_register_sessions(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_customer_contact_id_fkey FOREIGN KEY (customer_contact_id) REFERENCES public.suppliers(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES public.payment_methods(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_status_id_fkey FOREIGN KEY (status_id) REFERENCES public.sale_statuses(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.schedule_calendars
    ADD CONSTRAINT schedule_calendars_company_id_branch_id_fkey FOREIGN KEY (company_id, branch_id) REFERENCES public.branches(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.schedule_calendars
    ADD CONSTRAINT schedule_calendars_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.schedule_calendars
    ADD CONSTRAINT schedule_calendars_company_id_provider_id_fkey FOREIGN KEY (company_id, provider_id) REFERENCES public.service_providers(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.schedule_calendars
    ADD CONSTRAINT schedule_calendars_company_id_resource_id_fkey FOREIGN KEY (company_id, resource_id) REFERENCES public.schedule_resources(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.schedule_resources
    ADD CONSTRAINT schedule_resources_company_id_branch_id_fkey FOREIGN KEY (company_id, branch_id) REFERENCES public.branches(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.schedule_resources
    ADD CONSTRAINT schedule_resources_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.service_provider_branches
    ADD CONSTRAINT service_provider_branches_company_id_branch_id_fkey FOREIGN KEY (company_id, branch_id) REFERENCES public.branches(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.service_provider_branches
    ADD CONSTRAINT service_provider_branches_company_id_provider_id_fkey FOREIGN KEY (company_id, provider_id) REFERENCES public.service_providers(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.service_providers
    ADD CONSTRAINT service_providers_company_id_employee_id_fkey FOREIGN KEY (company_id, employee_id) REFERENCES public.employees(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.service_providers
    ADD CONSTRAINT service_providers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.service_providers
    ADD CONSTRAINT service_providers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.service_providers
    ADD CONSTRAINT service_providers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.service_schedule_branches
    ADD CONSTRAINT service_schedule_branches_company_id_branch_id_fkey FOREIGN KEY (company_id, branch_id) REFERENCES public.branches(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.service_schedule_branches
    ADD CONSTRAINT service_schedule_branches_company_id_profile_id_fkey FOREIGN KEY (company_id, profile_id) REFERENCES public.service_schedule_profiles(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.service_schedule_profiles
    ADD CONSTRAINT service_schedule_profiles_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.service_schedule_profiles
    ADD CONSTRAINT service_schedule_profiles_company_id_product_id_fkey FOREIGN KEY (company_id, product_id) REFERENCES public.products(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.service_schedule_profiles
    ADD CONSTRAINT service_schedule_profiles_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.service_schedule_providers
    ADD CONSTRAINT service_schedule_providers_company_id_profile_id_fkey FOREIGN KEY (company_id, profile_id) REFERENCES public.service_schedule_profiles(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.service_schedule_providers
    ADD CONSTRAINT service_schedule_providers_company_id_provider_id_fkey FOREIGN KEY (company_id, provider_id) REFERENCES public.service_providers(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.service_schedule_resources
    ADD CONSTRAINT service_schedule_resources_company_id_profile_id_fkey FOREIGN KEY (company_id, profile_id) REFERENCES public.service_schedule_profiles(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.service_schedule_resources
    ADD CONSTRAINT service_schedule_resources_company_id_resource_id_fkey FOREIGN KEY (company_id, resource_id) REFERENCES public.schedule_resources(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.stock_locations
    ADD CONSTRAINT stock_locations_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.stock_locations(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.commercial_documents(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_document_line_id_fkey FOREIGN KEY (document_line_id) REFERENCES public.commercial_document_lines(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.stock_transfer_lines
    ADD CONSTRAINT stock_transfer_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.stock_transfer_lines
    ADD CONSTRAINT stock_transfer_lines_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES public.stock_transfers(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_from_branch_id_fkey FOREIGN KEY (from_branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_received_by_fkey FOREIGN KEY (received_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_to_branch_id_fkey FOREIGN KEY (to_branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.supplier_categories
    ADD CONSTRAINT supplier_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.product_categories(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.supplier_categories
    ADD CONSTRAINT supplier_categories_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.supplier_payment_terms
    ADD CONSTRAINT supplier_payment_terms_payment_term_id_fkey FOREIGN KEY (payment_term_id) REFERENCES public.payment_terms(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.supplier_payment_terms
    ADD CONSTRAINT supplier_payment_terms_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.supplier_payments
    ADD CONSTRAINT supplier_payments_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.supplier_payments
    ADD CONSTRAINT supplier_payments_company_id_branch_id_fkey FOREIGN KEY (company_id, branch_id) REFERENCES public.branches(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.supplier_payments
    ADD CONSTRAINT supplier_payments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.supplier_payments
    ADD CONSTRAINT supplier_payments_company_id_supplier_id_fkey FOREIGN KEY (company_id, supplier_id) REFERENCES public.suppliers(company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.supplier_payments
    ADD CONSTRAINT supplier_payments_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES public.payment_methods(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.supplier_payments
    ADD CONSTRAINT supplier_payments_registered_by_fkey FOREIGN KEY (registered_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.user_branches
    ADD CONSTRAINT user_branches_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.user_branches
    ADD CONSTRAINT user_branches_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.user_companies
    ADD CONSTRAINT user_companies_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.user_companies
    ADD CONSTRAINT user_companies_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.user_companies
    ADD CONSTRAINT user_companies_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_cash_register_id_fkey FOREIGN KEY (cash_register_id) REFERENCES public.cash_registers(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_default_branch_id_fkey FOREIGN KEY (default_branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE public.barcode_print_preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merchandise_payment_audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "realtime sales select" ON public.sales FOR SELECT USING (true);
ALTER TABLE public.sale_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sales update status" ON public.sales FOR UPDATE USING (true) WITH CHECK (true);
ALTER TABLE public.supplier_payments ENABLE ROW LEVEL SECURITY;
INSERT INTO public.sale_statuses(name) VALUES ('Borrador') ON CONFLICT(name) DO NOTHING;
-- AUNA ENVIRONMENT BEGIN
REVOKE ALL ON TABLE public."accounting_periods" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."accounts" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."alert_priorities" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."alert_types" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."alerts" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."appointment_bookings" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."appointment_engagement_history" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."appointment_engagement_lines" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."appointment_engagement_schedules" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."appointment_engagements" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."appointment_history" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."appointment_participants" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."appointment_requests" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."appointment_session_providers" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."appointment_session_resources" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."appointment_sessions" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."appointment_waitlist" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."attendance" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."availability_exceptions" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."availability_rules" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."barcode_print_preparations" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."branches" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."cash_closure_denominations" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."cash_closure_payments" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."cash_closures" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."cash_register_sessions" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."cash_registers" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."commercial_document_lines" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."commercial_document_sales" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."commercial_documents" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."companies" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."company_modules" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."customer_payment_refunds" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."customer_payments" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."customer_price_rules" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."employee_advances" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."employee_document_types" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."employee_documents" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."employee_history" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."employees" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."incoming_merchandise" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."incoming_merchandise_items" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."incoming_merchandise_payment_entries" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."inventory_count_lines" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."inventory_count_sessions" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."journal_entries" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."journal_lines" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."merchandise_payment_audit_events" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."order_deliveries" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."order_delivery_lines" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."payment_allocation_events" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."payment_commitments" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."payment_methods" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."payment_terms" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."payroll_runs" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."payslip_lines" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."payslips" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."permissions" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."product_bom_lines" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."product_categories" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."product_lots" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."product_stock_locations" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."product_stocks" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."products" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."promotion_branches" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."promotion_categories" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."promotion_codes" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."promotion_coupon_assets" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."promotion_products" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."promotion_types" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."promotions" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."purchase_logs" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."refresh_tokens" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."return_items" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."return_replacement_items" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."return_settlements" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."return_statuses" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."returns" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."role_permissions" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."roles" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."sale_dtes" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."sale_history" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."sale_items" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."sale_payment_entries" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."sale_promotions" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."sale_statuses" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."sales" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."schedule_calendars" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."schedule_resources" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."service_provider_branches" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."service_providers" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."service_schedule_branches" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."service_schedule_profiles" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."service_schedule_providers" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."service_schedule_resources" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."statuses" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."stock_locations" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."stock_movements" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."stock_reservations" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."stock_statuses" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."stock_transfer_lines" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."stock_transfers" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."supplier_categories" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."supplier_payment_terms" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."supplier_payments" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."suppliers" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."system_settings" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."user_access_events" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."user_branches" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."user_companies" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."users" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."warehouses" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."accounting_periods_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."accounts_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."alert_priorities_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."alert_types_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."branches_seq_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."cash_closure_denominations_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."cash_closure_payments_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."cash_closures_closure_number_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."journal_lines_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."payment_methods_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."payment_terms_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."permissions_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."product_categories_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."promotion_categories_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."promotion_codes_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."promotion_products_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."promotion_types_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."purchase_logs_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."return_items_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."return_replacement_items_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."return_statuses_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."roles_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."sale_items_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."sale_promotions_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."sale_statuses_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."statuses_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."stock_statuses_id_seq" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public."system_settings_id_seq" FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public."sales" TO "anon";
REVOKE ALL ON FUNCTION public."capture_commercial_item_snapshot"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public."guard_confirmed_sale_payment_method"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public."capture_commercial_item_snapshot"() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public."guard_confirmed_sale_payment_method"() TO PUBLIC;
ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY public."sales";
-- AUNA ENVIRONMENT END
COMMIT;
