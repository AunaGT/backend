const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),http=require('node:http')
const root=process.cwd(),file=path.join(root,'tests/customer-statement-presentation.test.cjs')
const fixture=new Module(file,module);fixture.filename=file;fixture.paths=Module._nodeModulePaths(path.dirname(file))
const native=fixture.require.bind(fixture);fixture.require=name=>name==='node:test'?()=>{}:native(name)
fixture._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports={statement,renderStatement};',file)
const {statement,renderStatement}=fixture.exports
const data={...statement,resumen:{...statement.resumen,credito_disponible:0,credito_en_revision:75},cobros:statement.cobros.map(p=>({...p,amount:100,retenido:75,tiene_disputa:true,payment_method:{id:1,name:'Tarjeta'},no_aplicado:0}))}
const {html}=renderStatement({data})
const cssFile=fs.readFileSync(path.join(root,'dist/index.html'),'utf8').match(/href="\/assets\/([^\"]+\.css)"/)[1]
const chunks=fs.readdirSync(path.join(root,'dist/assets')).filter(f=>/^(compactList|CustomerStatementPage)-.*\.css$/.test(f));const css=[cssFile,...chunks].map(f=>fs.readFileSync(path.join(root,'dist/assets',f),'utf8')).join('\n')
const out=path.join(root,'output/qa/cash-disputes');fs.mkdirSync(out,{recursive:true})
const page='<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Estado de cuenta · Ejemplo sin conexión</title><style>'+css+'</style><style>body{margin:0}.qa-side{position:fixed;inset:0 auto 0 0;width:56px;border-right:1px solid hsl(var(--border));text-align:center;padding-top:18px}.qa-main{margin-left:56px}.qa-header{padding:16px 24px;border-bottom:1px solid hsl(var(--border));font-size:14px}@media(max-width:640px){.qa-side{display:none}.qa-main{margin-left:0}}</style></head><body><aside class="qa-side">A</aside><div class="qa-main"><header class="qa-header">Auna · Cartera</header>'+html+'</div></body></html>'
fs.writeFileSync(path.join(out,'customer-held-preview.html'),page)
if(process.argv.includes('--render-only'))process.exit(0)
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1')
 if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return}
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(out,'customer-held-preview.html'),'utf8'));return}
 if(/^\/assets\/[a-zA-Z0-9_.-]+\.(woff2?|ttf)$/.test(url.pathname)){
  const p=path.join(root,'dist/assets',path.basename(url.pathname));if(fs.existsSync(p)){res.end(fs.readFileSync(p));return}
 }
 res.writeHead(404);res.end()
})
server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(path.join(root,'.superpowers/sdd/2026-11-22-cash-payment-disputes/preview-process.json'),JSON.stringify({pid:process.pid,port:server.address().port}));console.log('Synthetic credit preview: http://127.0.0.1:'+server.address().port)})
