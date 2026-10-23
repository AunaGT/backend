const {fail,uuid}=require('../validation')
function object(value,keys){if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!keys.includes(k)))fail(400,'Datos de impresión no admitidos')}
function source(value){object(value,['kind','id']);if(!['SALE_TICKET','LABEL_PREPARATION'].includes(value.kind))fail(400,'Origen no admitido');return{kind:value.kind,id:uuid(value.id,'source.id')}}
function jobInput(value){
  object(value,['requestKey','source','workstationId','destinationId','pages','document'])
  // shortcut: document-wide jobs only; add subsets when every versioned renderer can preserve page selection.
  if(value.pages!==undefined&&(!Array.isArray(value.pages)||value.pages.length))fail(400,'Por ahora se prepara el documento completo; selecciona páginas en el visor PDF')
  if(!['MAIN','GUIDE'].includes(value.document))fail(400,'Documento no admitido')
  if(value.destinationId&&!value.workstationId)fail(400,'El destino necesita un puesto')
  return{requestKey:uuid(value.requestKey,'requestKey'),source:source(value.source),document:value.document,pages:[],workstationId:value.workstationId?uuid(value.workstationId,'workstationId'):null,destinationId:value.destinationId?uuid(value.destinationId,'destinationId'):null}
}
function eventInput(value){object(value,['requestKey','event','errorCode']);if(!['PREPARED','DOWNLOAD_REQUESTED','FAILED'].includes(value.event))fail(400,'Estado no admitido');if(value.event==='FAILED'?!['RENDER_FAILED','DOWNLOAD_FAILED','CANCELLED'].includes(value.errorCode):value.errorCode!==undefined)fail(400,'Error no admitido');return{requestKey:uuid(value.requestKey,'requestKey'),event:value.event,errorCode:value.errorCode||null}}
function downloadInput(value){object(value,['preparedRequestKey','downloadRequestKey']);const preparedRequestKey=uuid(value.preparedRequestKey,'preparedRequestKey'),downloadRequestKey=uuid(value.downloadRequestKey,'downloadRequestKey');if(preparedRequestKey===downloadRequestKey)fail(400,'Cada evento necesita una referencia distinta');return{preparedRequestKey,downloadRequestKey}}
function documentOption(value){if(value!==undefined&&value!=='true')fail(400,'Opción de documento no admitida');return value==='true'}
function documentOptions(query={}){const includeDocument=documentOption(query.includeDocument),includeLogo=documentOption(query.includeLogo);if(includeLogo&&!includeDocument)fail(400,'El logo necesita el documento');return{includeDocument,includeLogo}}
function reprintInput(value){object(value,['requestKey','reason','pdfOnly']);if(value.pdfOnly!==undefined&&typeof value.pdfOnly!=='boolean')fail(400,'Selecciona PDF sin equipo o conserva el destino');if(typeof value.reason!=='string'||!value.reason.trim()||value.reason.trim().length>500)fail(400,'Indica el motivo de la copia (hasta 500 caracteres)');return{requestKey:uuid(value.requestKey,'requestKey'),reason:value.reason.trim(),pdfOnly:value.pdfOnly===true}}
module.exports={jobInput,eventInput,reprintInput,downloadInput,documentOption,documentOptions}
