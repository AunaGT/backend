const { prisma, prismaTransaction } = require('../../models/prisma')
const { requestScope, assertAppointmentsEnabled } = require('./access')
const app = require('./application')
const queries = require('./queries')
const activities = require('./activities')
const engagements=require('./engagements')
const { saveServiceProfile, getServiceProfile } = require('./profiles')
const { saveProvider, saveResource, listDirectory } = require('./directory')
const { saveCalendar, getCalendar } = require('./calendars')
function handler(run, status = 200) {
  return async (req, res, next) => {
    try { res.status(status).json(await run(req, requestScope(req))) }
    catch (error) {
      if (error.status) return res.status(error.status).json({ message: error.message, code: error.code || 'INVALID_INPUT', ...(error.fields ? { fields: error.fields } : {}) })
      if (error.code === 'P2002') return res.status(409).json({ message: 'El registro ya existe o fue reservado por otra persona', code: 'CONFLICT' })
      if (error.code === 'P2028') return res.status(503).json({ message: 'No se pudo completar la operación; vuelve a intentar el mismo envío', code: 'RETRY_TRANSACTION' })
      next(error)
    }
  }
}
const configWrite = (run, status = 200) => handler(async (req, scope) => {
  app.requireAction(scope, 'appointments.configure')
  return app.withAgendaTransaction(prismaTransaction, scope.companyId, async tx => { await assertAppointmentsEnabled(tx, scope); return run(tx, req, scope) })
}, status)
exports.availability = handler((r, s) => queries.readAvailability(prisma, s, r.body))
exports.billingSourcePreview=handler((r,s)=>require('./billingSources').previewBillingSource(prisma,s,r.params.kind,r.params.id,r.body))
exports.prepareSourceBilling=handler((r,s)=>require('./billingSources').prepareBillingSource(prismaTransaction,s,r.params.kind,r.params.id,r.body),201)
exports.createEngagement=handler((r,s)=>engagements.createEngagement(prismaTransaction,s,r.body),201)
exports.engagement=handler((r,s)=>engagements.getEngagement(prisma,s,r.params.id))
exports.programEngagement=handler((r,s)=>engagements.programEngagement(prismaTransaction,s,r.params.id,r.body))
exports.collectEngagementPayment=handler((r,s)=>require('./engagementPayments').collectEngagementPayment(prismaTransaction,s,r.params.id,r.body),201)
exports.issueEngagementSale=handler((r,s)=>require('./engagementSales').issueEngagementSale(prismaTransaction,s,r.params.id,r.body),201)
exports.resolveEngagementFunds=handler((r,s)=>require('./engagementResolution').resolveEngagementFunds(prismaTransaction,s,r.params.id,r.body))
exports.sessionAvailability = handler((r, s) => queries.readSessionAvailability(prisma, s, r.body))
exports.moveBookingAvailability = handler((r, s) => queries.readMoveAvailability(prisma, s, 'booking', r.params.id, r.body))
exports.moveSessionAvailability = handler((r, s) => queries.readMoveAvailability(prisma, s, 'session', r.params.id, r.body))
exports.contacts = handler((r, s) => queries.listContacts(prisma, s, r.query))
exports.bookings = handler((r, s) => queries.listBookings(prisma, s, r.query))
exports.sessions = handler((r, s) => queries.listSessions(prisma, s, r.query))
exports.summary = handler((r, s) => queries.readSummary(prisma, s, r.query))
exports.services = handler((r, s) => queries.listServices(prisma, s, r.query))
exports.service = handler(async (r, s) => {
  const result = await queries.listServices(prisma, s, { id: r.params.id })
  if (!result.items.length) require('./domain/validation').fail(404, 'NOT_FOUND', 'Servicio no encontrado')
  return result.items[0]
})
exports.booking = handler((r, s) => queries.getBooking(prisma, s, r.params.id))
exports.session = handler((r, s) => queries.getSession(prisma, s, r.params.id, r.query))
exports.directory = handler((r, s) => listDirectory(prisma, s))
exports.activity = handler((r,s)=>activities.getActivity(prisma,s,r.params.id))
exports.activityUsers = handler((r,s)=>activities.listActivityUsers(prisma,s,r.query))
exports.entries = handler((r,s)=>require('./entries').listEntries(prisma,s,r.query))
exports.entriesSummary = handler((r,s)=>require('./entries').readEntriesSummary(prisma,s,r.query))
exports.createActivity = handler((r,s)=>activities.createActivity(prismaTransaction,s,r.body),201)
exports.updateActivity = handler((r,s)=>activities.updateActivity(prismaTransaction,s,r.params.id,r.body))
exports.transitionActivity = handler((r,s)=>activities.transitionActivity(prismaTransaction,s,r.params.id,r.body))
exports.profile = handler((r, s) => getServiceProfile(prisma, s, r.params.id))
exports.calendar = handler((r, s) => getCalendar(prisma, s, r.params.type, r.params.id))
exports.saveProfile = configWrite((tx, r, s) => saveServiceProfile(tx, s, r.params.id, r.body))
exports.saveCalendar = configWrite((tx, r, s) => saveCalendar(tx, s, r.params.type, r.params.id, r.body))
exports.createProvider = configWrite((tx, r, s) => saveProvider(tx, s, null, r.body), 201)
exports.updateProvider = configWrite((tx, r, s) => saveProvider(tx, s, r.params.id, r.body))
exports.createResource = configWrite((tx, r, s) => saveResource(tx, s, null, r.body), 201)
exports.updateResource = configWrite((tx, r, s) => saveResource(tx, s, r.params.id, r.body))
for (const [name, method, id, status] of [
  ['createBooking', 'createBooking', false, 201], ['createSession', 'createSession', false, 201], ['enroll', 'enrollBooking', true, 201],
  ['moveBooking', 'rescheduleBooking', true], ['moveSession', 'rescheduleSession', true],
  ['transitionBooking', 'transitionBooking', true], ['transitionSession', 'transitionSession', true],
  ['joinWaitlist', 'joinWaitlist', true, 201], ['admitWaitlist', 'admitWaitlist', true], ['withdrawWaitlist', 'withdrawWaitlist', true],
]) exports[name] = handler((r, s) => app[method](prismaTransaction, s, ...(id ? [r.params.id] : []), r.body), status || 200)
