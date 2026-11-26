// Esperar las respuestas evita cortar una operación cuando nodemon reemplaza el proceso.
function installServerShutdown(server,disconnect){
  let closing=false
  const handlers={}
  async function stop(signal){
    if(closing)return
    closing=true
    const timeout=setTimeout(()=>{
      console.error('[server] Tiempo de cierre agotado; revisa las peticiones que seguían activas.')
      server.closeAllConnections?.()
      process.exit(1)
    },30000)
    timeout.unref()
    server.close(async()=>{
      let code=0
      try{await disconnect()}catch{code=1;console.error('[server] No se pudieron cerrar todas las conexiones de datos.')}
      clearTimeout(timeout)
      for(const [name,handler] of Object.entries(handlers))process.off(name,handler)
      if(signal==='SIGUSR2'&&code===0)process.kill(process.pid,'SIGTERM')
      else process.exit(code)
    })
    server.closeIdleConnections?.()
  }
  for(const signal of ['SIGINT','SIGTERM','SIGUSR2']){
    handlers[signal]=()=>void stop(signal)
    process.on(signal,handlers[signal])
  }
}
module.exports={installServerShutdown}
