const base=row=>({id:row.id,companyId:row.company_id,branchId:row.branch_id,code:row.code,name:row.name,notes:row.notes,state:row.state,version:row.version})
const workstation=row=>({...base(row),cashRegisterId:row.cash_register_id})
const device=row=>({...base(row),kind:row.kind,connection:row.connection,profile:row.profile,evidence:'PENDING_PHYSICAL_TEST'})
const assignment=row=>({id:row.id,workstationId:row.workstation_id,deviceId:row.device_id,role:row.role})
const testRun=row=>({id:row.id,branchId:row.branch_id,actorId:row.actor_id,workstationId:row.workstation_id,deviceId:row.device_id,kind:row.kind,mode:row.mode,outcome:row.outcome,sampleCode:row.sample_code,createdAt:row.created_at})
const audit=row=>({id:row.id,branchId:row.branch_id,actorId:row.actor_id,action:row.action,entityId:row.entity_id,before:row.before,after:row.after,createdAt:row.created_at})
module.exports={workstation,device,assignment,testRun,audit}
