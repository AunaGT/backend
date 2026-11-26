// Start with a dedicated service account and a minimal environment, never dotenv.
const {createSandboxApp}=require('../src/customerPagesSandbox/app')
const artifactRoot=process.env.PORTAL_SANDBOX_ARTIFACT_ROOT,allowedEmbedOrigins=(process.env.PORTAL_SANDBOX_PARENT_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean),port=Number(process.env.PORTAL_SANDBOX_PORT||8091)
if(!artifactRoot||!allowedEmbedOrigins.length||!Number.isInteger(port)||port<1024||port>65535)throw Error('Configure sandbox root, trusted parents and an unprivileged port')
createSandboxApp({artifactRoot,allowedEmbedOrigins}).listen(port,'127.0.0.1',()=>console.info('Portal visual isolation service ready'))
