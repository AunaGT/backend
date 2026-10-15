function publicServiceConditions(profile) {
  if(!profile) return null
  return {version:1,schedulingStyle:profile.schedulingStyle,durationPolicy:profile.durationPolicy,
    durationMinutes:profile.durationMinutes,allowedVenueKinds:[...profile.allowedVenueKinds],publicInstructions:profile.publicInstructions||''}
}
module.exports={publicServiceConditions}
