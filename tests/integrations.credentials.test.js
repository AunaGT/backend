const test = require('node:test'), assert = require('node:assert/strict')
const credentials = () => require('../src/modules/integrations/credentials')
test('integration secrets are independent, verifiable and not recoverable from stored data', () => {
  const { issueCredential, parseCredential, verifySecret } = credentials(), a = issueCredential(), b = issueCredential()
  assert.notEqual(a.apiKey,b.apiKey)
  const parsed = parseCredential(a.apiKey)
  assert.equal(parsed.publicId,a.publicId)
  assert.equal(verifySecret(parsed.secret,a.secretHash),true)
  assert.equal(verifySecret(parseCredential(b.apiKey).secret,a.secretHash),false)
  assert.equal(a.secretHash.length,64)
  assert.ok(!a.secretHash.includes(parsed.secret))
  for(const raw of ['', 'Bearer abc', 'x'.repeat(1000), 'jwt.token.signature', a.apiKey+'x']) assert.equal(parseCredential(raw),null)
  assert.equal(verifySecret(parsed.secret,'garbage'),false)
})
test('creation input rejects hidden authority, broad scopes, missing branches and bad expiry', () => {
  const { parseCreateInput } = credentials(), good={name:'Tienda',ownerId:'11111111-1111-4111-8111-111111111111',scopes:['products.read'],branchIds:['22222222-2222-4222-8222-222222222222']}
  assert.equal(parseCreateInput(good).days,90)
  for(const change of [{companyId:'other'},{scopes:['*']},{scopes:[]},{branchIds:[]},{days:0},{days:366},{days:1.5},{name:' '},{ownerId:'bad'}]) assert.throws(()=>parseCreateInput({...good,...change}),{status:400})
})
