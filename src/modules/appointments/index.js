const {publicServiceConditions}=require('./domain/publicServiceConditions')
const publicProfileSelect={scheduling_style:true,duration_policy:true,duration_minutes:true,allowed_venue_kinds:true,public_instructions:true}
function publicConditionsFromRow(row){
  return row ? publicServiceConditions({schedulingStyle:row.scheduling_style,durationPolicy:row.duration_policy,durationMinutes:row.duration_minutes,
    allowedVenueKinds:row.allowed_venue_kinds,publicInstructions:row.public_instructions}) : null
}
module.exports={publicServiceConditions,publicProfileSelect,publicConditionsFromRow}
module.exports.quoteAgendaContext=(...args)=>require('./quoteContext').quoteAgendaContext(...args)
module.exports.linkedEngagementOrigins=(...args)=>require('./quoteContext').linkedEngagementOrigins(...args)
