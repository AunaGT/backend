require('./setup-env')
const test = require('node:test'), assert = require('node:assert/strict')
const { computeSlots, sessionOccupies } = require('../src/modules/appointments/domain/availability')
function fixture() {
  const branch = { owner_type: 'branch', branch_id: 'b', timezone: 'America/Guatemala', rules: [{ weekday: 1, from_minute: 540, to_minute: 660 }], exceptions: [] }
  return { profile: { enabled: true, mode: 'INDIVIDUAL', durationMinutes: 30, beforeMinutes: 0, afterMinutes: 0, intervalMinutes: 30, leadMinutes: 0, horizonDays: 60, requiresProvider: true, requiresResource: true, capacity: 1 },
    calendars: [branch, { ...branch, owner_type: 'provider', branch_id: null, provider_id: 'p', inherit_branch: true, rules: [] }, { ...branch, owner_type: 'resource', branch_id: null, resource_id: 'r', inherit_branch: true, rules: [] }],
    providers: [{ id: 'p', employee_id: 'e' }], resources: [{ id: 'r', person_capacity: null }], sessions: [], bookings: [], absenceDates: [],
    from: '2026-10-12T15:00:00Z', to: '2026-10-12T17:00:00Z', now: new Date('2026-10-12T12:00:00Z') }
}
const starts = input => computeSlots(input).map(s => s.startsAt)
test('servicio sin requisitos ni asignaciones no ofrece franjas de personal ficticias',()=>{
  const f=fixture();f.profile.requiresProvider=false;f.profile.requiresResource=false
  assert.deepEqual(computeSlots(f),[])
})
test('intervalo concreto editable verifica conflicto en el final y márgenes',()=>{
  const f=fixture();f.profile.durationMinutes=90
  f.from='2026-10-12T15:00:00Z';f.to='2026-10-12T15:01:00Z'
  f.busyAssignments=[{start:new Date('2026-10-12T16:00Z').getTime(),end:new Date('2026-10-12T16:30Z').getTime(),providerIds:['p'],resourceIds:[],sessionId:'other'}]
  assert.deepEqual(computeSlots({...f,exactStart:f.from}),[])
  f.busyAssignments=[]
  f.to='2026-10-12T15:08:00Z'
  assert.equal(computeSlots({...f,exactStart:'2026-10-12T15:07:00.000Z'})[0]?.startsAt,'2026-10-12T15:07:00.000Z')
})
test('slots comerciales bloquean asignaciones expandidas de una reunión y respetan bordes',()=>{
  const f=fixture()
  f.busyAssignments=[{start:new Date(f.from).getTime(),end:new Date('2026-10-12T15:30Z').getTime(),providerIds:['p'],resourceIds:[],sessionId:'reunion'}]
  assert.equal(starts(f)[0],'2026-10-12T15:30:00.000Z')
})
test('rango diario incluye inicios nocturnos; valida el intervalo ocupado completo fuera del rango',()=>{
  const f=fixture();f.profile.durationMinutes=45;f.profile.intervalMinutes=15
  f.from='2026-10-12T06:00:00Z';f.to='2026-10-13T06:00:00Z'
  f.calendars[0].rules=[{weekday:1,from_minute:1380,to_minute:1440},{weekday:2,from_minute:0,to_minute:60}]
  assert.ok(starts(f).includes('2026-10-13T05:45:00.000Z'))
  assert.ok(starts(f).every(s=>new Date(s)<new Date(f.to)))
  f.sessions=[{id:'busy',mode:'GROUP',status:'SCHEDULED',occupied_from:new Date('2026-10-13T06:00Z'),occupied_until:new Date('2026-10-13T06:30Z'),providers:[{provider_id:'p'}],resources:[]}]
  assert.ok(!starts(f).includes('2026-10-13T05:45:00.000Z'))
})
test('intersección explícita, buffers, descansos y excepciones parciales', () => {
  const f = fixture()
  assert.deepEqual(starts(f), ['2026-10-12T15:00:00.000Z', '2026-10-12T15:30:00.000Z', '2026-10-12T16:00:00.000Z', '2026-10-12T16:30:00.000Z'])
  f.profile.beforeMinutes = 15
  f.calendars[1].exceptions = [{ local_date: new Date('2026-10-12'), from_minute: 600, to_minute: 630 }]
  assert.deepEqual(starts(f), ['2026-10-12T15:30:00.000Z'])
  f.calendars.pop()
  assert.deepEqual(starts(f), [])
})
test('misma persona en otra sucursal bloquea; retención expirada y bordes no', () => {
  const f = fixture()
  f.sessions = [{ id: 's', branch_id: 'hidden', mode: 'INDIVIDUAL', status: 'SCHEDULED', occupied_from: new Date(f.from), occupied_until: new Date('2026-10-12T15:30Z'), providers: [{ provider_id: 'p' }], resources: [] }]
  f.bookings = [{ session_id: 's', status: 'HELD', expires_at: f.now }]
  assert.equal(starts(f).length, 4)
  f.bookings[0].status = 'CONFIRMED'
  assert.equal(starts(f)[0], '2026-10-12T15:30:00.000Z')
  f.absenceDates = [{ employee_id: 'e', work_date: new Date('2026-10-12'), status: 'AUSENTE' }]
  assert.deepEqual(starts(f), [])
})
test('grupo vacío ocupa y disponibilidad grupal solo ofrece sesiones existentes con cupo', () => {
  const f = fixture()
  const s = { id: 's', product_id: 'product', branch_id: 'b', mode: 'GROUP', status: 'SCHEDULED', starts_at: new Date(f.from), ends_at: new Date('2026-10-12T15:30Z'), occupied_from: new Date(f.from), occupied_until: new Date('2026-10-12T15:30Z'), capacity: 1, timezone: 'America/Guatemala', providers: [{ provider_id: 'p' }], resources: [{ resource_id: 'r' }] }
  assert.equal(sessionOccupies(s, [], f.now), true)
  f.profile.mode = 'GROUP'; f.sessions = [s]
  assert.equal(computeSlots(f)[0].remaining, 1)
  f.bookings = [{ session_id: 's', status: 'CONFIRMED' }]
  assert.deepEqual(computeSlots(f), [])
})
test('horario nocturno dividido es continuo, equipo sin capacidad no limita a una persona', () => {
  const f = fixture()
  f.profile.durationMinutes = 60
  f.from = '2026-10-13T05:30:00Z'; f.to = '2026-10-13T07:00:00Z'
  f.calendars[0].rules = [{ weekday: 1, from_minute: 1380, to_minute: 1440 }, { weekday: 2, from_minute: 0, to_minute: 60 }]
  assert.deepEqual(starts(f), ['2026-10-13T05:30:00.000Z', '2026-10-13T06:00:00.000Z'])
})
test('31 días y 500 sesiones se leen en lote, no por horario', async () => {
  const { readAvailability } = require('../src/modules/appointments/queries')
  const f = fixture(), reads = []
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const provider = { id: id(3), employee_id: null, branches: [{ branch_id: id(2) }], user_id: id(4) }
  const db = {}
  for (const [model, result] of Object.entries({
    companyModule: [{ module_code: 'appointments', status: 'ACTIVE' }],
    serviceProvider: [provider], employee:[], scheduleResource: [], scheduleCalendar: f.calendars.slice(0, 2).map(c => ({ ...c, branch_id: c.owner_type === 'branch' ? id(2) : null, provider_id: c.owner_type === 'provider' ? id(3) : null })),
    appointmentSession: Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, mode: 'INDIVIDUAL', status: 'SCHEDULED', occupied_from: new Date('2025-01-01'), occupied_until: new Date('2025-01-02'), providers: [], resources: [], bookings: [] })),
  })) db[model] = { findMany: async () => { reads.push(model); return result } }
  db.systemSetting = { findUnique: async () => ({ value: 'true' }) }
  db.serviceScheduleProfile = { findFirst: async () => ({ id: id(5), enabled: true, mode: 'INDIVIDUAL', duration_minutes: 30, before_minutes: 0, after_minutes: 0, interval_minutes: 30, lead_minutes: 0, horizon_days: 60, capacity: 1, requires_provider: true, requires_resource: false, branches: [{ branch_id: id(2) }], providers: [{ provider_id: id(3) }], resources: [], product: { kind: 'SERVICE', deleted: false, available_for_sale: true } }) }
  const slots = await readAvailability(db, { companyId: id(1), branchId: id(2), branchIds: [id(2)], userId: id(4), isAdmin: true, permissions: [] }, { productId: id(5), from: f.from, to: '2026-11-12T15:00:00Z' }, f.now)
  assert.ok(slots.length > 4)
  assert.equal(reads.filter(r => r === 'appointmentSession').length, 1)
  assert.equal(reads.filter(r => r === 'scheduleCalendar').length, 1)
  assert.ok(reads.length <= 12,'Consultas de identidad acotadas por período, no por horario')
})
