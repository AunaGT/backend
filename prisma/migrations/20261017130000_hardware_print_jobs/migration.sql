CREATE TABLE public.hardware_print_jobs (
 id uuid PRIMARY KEY, company_id uuid NOT NULL, branch_id uuid NOT NULL, actor_id uuid NOT NULL,
 request_key uuid NOT NULL, request_hash varchar(64) NOT NULL,
 source_kind varchar(30) NOT NULL CHECK(source_kind IN ('SALE_TICKET','LABEL_PREPARATION')),
 source_id uuid NOT NULL, snapshot jsonb NOT NULL CHECK(octet_length(snapshot::text)<=2200000),
 route_snapshot jsonb NOT NULL, workstation_id uuid, parent_id uuid, reason varchar(500),
 document varchar(10) NOT NULL CHECK(document IN ('MAIN','GUIDE')), pages integer[] NOT NULL,
 state varchar(30) NOT NULL DEFAULT 'CREATED' CHECK(state IN ('CREATED','PREPARED','DOWNLOAD_REQUESTED','FAILED')),
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamp(3) NOT NULL,
 CONSTRAINT hardware_print_jobs_company_id_actor_id_request_key_key UNIQUE(company_id,actor_id,request_key),
 UNIQUE(company_id,branch_id,actor_id,id),
 FOREIGN KEY(company_id,branch_id) REFERENCES public.branches(company_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY(actor_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY(company_id,branch_id,actor_id,parent_id) REFERENCES public.hardware_print_jobs(company_id,branch_id,actor_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX hardware_print_jobs_company_id_branch_id_created_at_idx ON public.hardware_print_jobs(company_id,branch_id,created_at);
CREATE TABLE public.hardware_print_events (
 id uuid PRIMARY KEY, job_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL, actor_id uuid NOT NULL,
 request_key uuid NOT NULL, event varchar(30) NOT NULL CHECK(event IN ('PREPARED','DOWNLOAD_REQUESTED','FAILED')),
 error_code varchar(40), created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT hardware_print_events_job_id_fkey FOREIGN KEY(company_id,branch_id,actor_id,job_id) REFERENCES public.hardware_print_jobs(company_id,branch_id,actor_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT hardware_print_events_job_id_request_key_key UNIQUE(job_id,request_key)
);
CREATE INDEX hardware_print_events_company_id_branch_id_created_at_idx ON public.hardware_print_events(company_id,branch_id,created_at);
ALTER TABLE public.hardware_print_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hardware_print_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hardware_print_jobs,public.hardware_print_events FROM PUBLIC,anon,authenticated,service_role;
