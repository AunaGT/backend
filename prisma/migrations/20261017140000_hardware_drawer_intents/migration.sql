CREATE TABLE public.hardware_drawer_policies (
 company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), policy jsonb NOT NULL, updated_at timestamp(3) NOT NULL
);
CREATE TABLE public.hardware_drawer_intents (
 id uuid PRIMARY KEY, company_id uuid NOT NULL, branch_id uuid NOT NULL, actor_id uuid NOT NULL,
 origin varchar(40) NOT NULL CHECK(origin IN ('POS_SALE','INITIAL_CREDIT_RECEIPT','RECEIVABLE_RECEIPT','AGENDA_RECEIPT','CASH_RETURN')),
 source_type varchar(30) NOT NULL CHECK(source_type IN ('SALE','CUSTOMER_PAYMENT','RETURN_SETTLEMENT')), source_id uuid NOT NULL,
 amount decimal(12,2) NOT NULL CHECK(amount>0), session_id uuid NOT NULL, workstation_id uuid NOT NULL, drawer_id uuid NOT NULL,
 route_snapshot jsonb NOT NULL, policy_version integer NOT NULL,
 state varchar(20) NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','CLAIMED','SIMULATED','UNKNOWN','EXPIRED')),
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at timestamp(3) NOT NULL, claimed_at timestamp(3),
 UNIQUE(company_id,source_type,source_id,drawer_id), UNIQUE(company_id,branch_id,actor_id,id),
 FOREIGN KEY(company_id,branch_id) REFERENCES public.branches(company_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY(actor_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY(company_id,branch_id,workstation_id) REFERENCES public.hardware_workstations(company_id,branch_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY(company_id,branch_id,drawer_id) REFERENCES public.hardware_devices(company_id,branch_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY(session_id) REFERENCES public.cash_register_sessions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 seconds')
);
CREATE INDEX hardware_drawer_intents_company_id_branch_id_created_at_idx ON public.hardware_drawer_intents(company_id,branch_id,created_at);
CREATE TABLE public.hardware_drawer_attempts (
 id uuid PRIMARY KEY, intent_id uuid NOT NULL UNIQUE, company_id uuid NOT NULL, branch_id uuid NOT NULL, actor_id uuid NOT NULL,
 request_key uuid NOT NULL, token_hash varchar(64) NOT NULL, expires_at timestamp(3) NOT NULL,
 outcome varchar(20) CHECK(outcome IN ('SIMULATED','UNKNOWN')), created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(company_id,actor_id,request_key), CONSTRAINT drawer_attempt_scoped_identity UNIQUE(company_id,branch_id,actor_id,intent_id),
 FOREIGN KEY(company_id,branch_id,actor_id,intent_id) REFERENCES public.hardware_drawer_intents(company_id,branch_id,actor_id,id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE public.hardware_drawer_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hardware_drawer_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hardware_drawer_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hardware_drawer_policies,public.hardware_drawer_intents,public.hardware_drawer_attempts FROM PUBLIC,anon,authenticated,service_role;
