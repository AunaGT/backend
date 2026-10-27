const test=require('node:test'),assert=require('node:assert/strict')
const {timelineTestUrl}=require('./helpers/timelineTestDb.cjs')
test('timeline PostgreSQL tests reject missing, application, remote and non-disposable URLs',()=>{
 for(const raw of [undefined,'postgresql://host/auna_timeline_test_x','postgresql://localhost/auna','postgresql://localhost/auna_timeline_test_x?schema=public','https://localhost/auna_timeline_test_x'])assert.throws(()=>timelineTestUrl({APPOINTMENTS_TIMELINE_TEST_DATABASE_URL:raw}))
 const url='postgresql://test@127.0.0.1:55439/auna_timeline_test_x'
 assert.equal(timelineTestUrl({APPOINTMENTS_TIMELINE_TEST_DATABASE_URL:url}),url)
 assert.throws(()=>timelineTestUrl({APPOINTMENTS_TIMELINE_TEST_DATABASE_URL:url,DATABASE_URL:url}))
})
