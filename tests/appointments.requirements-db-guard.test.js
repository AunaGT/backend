const test=require('node:test'),assert=require('node:assert/strict')
const {requirementsTestUrl}=require('./helpers/requirementsTestDb.cjs')
test('requirements tests refuse application or remote databases without connecting',()=>{
 const local='postgresql://test@127.0.0.1:55493/auna_requirements_test_example'
 assert.equal(requirementsTestUrl({APPOINTMENTS_REQUIREMENTS_TEST_DATABASE_URL:local}),local)
 for(const raw of [undefined,'bad',local.replace('127.0.0.1','example.com'),local.replace('auna_requirements_test_example','postgres'),local+'?schema=public',local+'#fragment'])assert.throws(()=>requirementsTestUrl({APPOINTMENTS_REQUIREMENTS_TEST_DATABASE_URL:raw}))
 for(const key of ['DATABASE_URL','DIRECT_URL'])assert.throws(()=>requirementsTestUrl({APPOINTMENTS_REQUIREMENTS_TEST_DATABASE_URL:local,[key]:local}))
})
