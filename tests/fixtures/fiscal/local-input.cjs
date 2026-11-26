const { fixture } = require('./preparation.cjs')
const { buildLocalProfile } = require('../../../src/modules/fiscal/profiles')
const { prepareFiscalSnapshot } = require('../../../src/modules/fiscal/snapshots')
function localInput(f = fixture()) {
  return prepareFiscalSnapshot(f.scope, f.sale, {
    source: 'LOCAL_SAMPLE', issuedAt: '2026-10-23T10:00:00-06:00', products: f.products,
    connectorVersion: { id: f.ids.version, company_id: f.ids.company, connector_id: f.ids.connector, environment: 'TEST', contract_id: 'infile-unified-offline-v1', profile: buildLocalProfile(f.draft, f.settings) },
    renderProfiles: { LETTER: { versionId: 'synthetic-only' } },
  })
}
module.exports = { localInput }
