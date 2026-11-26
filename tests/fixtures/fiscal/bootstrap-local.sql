CREATE TABLE IF NOT EXISTS public.companies (id uuid PRIMARY KEY);
CREATE TABLE public.branches (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), name text NOT NULL, active boolean NOT NULL DEFAULT true, UNIQUE(company_id,id));
CREATE TABLE public.product_categories (id integer PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), name text NOT NULL, deleted boolean NOT NULL DEFAULT false);
CREATE TABLE public.products (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), category_id integer NOT NULL REFERENCES product_categories(id), name text NOT NULL, deleted boolean NOT NULL DEFAULT false, kind text NOT NULL DEFAULT 'STANDARD');
CREATE TABLE public.measure_units (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), name text NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE TABLE public.product_presentations (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), product_id uuid NOT NULL REFERENCES products(id), name text NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE TABLE public.system_settings (id serial PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), key varchar(100) NOT NULL, value text NOT NULL, revision integer NOT NULL DEFAULT 1, UNIQUE(company_id,key));
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;
