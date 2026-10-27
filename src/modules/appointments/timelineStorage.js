const {fail}=require('./domain/validation')
// Deploy the additive migration before generating the active client; old clients stay usable meanwhile.
function timelineStorageReady(db){return !db._runtimeDataModel||!!db._runtimeDataModel.models?.AppointmentSession?.fields.some(f=>f.name==='operational_timeline')}
function timelineSelect(db){return timelineStorageReady(db)?{operational_timeline:true}:{}}
function assertTimelineStorage(db){if(!timelineStorageReady(db))fail(409,'TIMELINE_NOT_READY','Esta función necesita la actualización de Agenda. Solicita al administrador que aplique la migración antes de usarla')}
module.exports={timelineStorageReady,timelineSelect,assertTimelineStorage}
