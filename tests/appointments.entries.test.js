const test=require('node:test'),assert=require('node:assert/strict')
test('filtro unificado conserva alcance y aplica solapamiento, propósito y lugar sin maestros',()=>{
  const {entryFilter}=require('../src/modules/appointments/entries')
  const {where,filter}=entryFilter({companyId:'c',branchId:'b',userId:'u',permissions:[],isAdmin:false},
    {from:'2030-01-01T00:00Z',to:'2030-01-02T00:00Z',q:'Reunión',purpose:'MEETING',venueKind:'ONLINE',page:'2'}, {catalog:false,contacts:false})
  assert.equal(filter.pageSize,10);assert.equal(filter.page,2);assert.equal(where.company_id,'c')
  assert.ok(where.occupied_from.lt);assert.ok(where.occupied_until.gt)
  const json=JSON.stringify(where);assert.match(json,/MEETING/);assert.match(json,/ONLINE/);assert.doesNotMatch(json,/"contact"|"product"/)
})
