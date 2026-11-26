const {createHash}=require('node:crypto')
const {object,uuid,fail}=require('./credentials')
const {parseDraftItems,canonical,text}=require('./draftInput')

function parseMutationInput(action,raw){
 if(action==='CANCEL_DRAFT'){object(raw,[]);return{}}
 if(action!=='UPDATE_DRAFT')fail(400)
 object(raw,['items','notes'])
 if(!Object.keys(raw).length)fail(400)
 const input={}
 if(Object.hasOwn(raw,'items'))input.items=parseDraftItems(raw.items)
 if(Object.hasOwn(raw,'notes'))input.notes=raw.notes===null?null:text(raw.notes,2000)
 return input
}
function parseIfMatch(header){
 if(header===undefined||header===null||header==='')fail(428,'PRECONDITION_REQUIRED')
 const match=typeof header==='string'&&/^"auna-draft-v1:([0-9a-f-]{36})"$/i.exec(header)
 if(!match||!header.startsWith('"auna-draft-v1:')||!uuid(match[1]))fail(412,'VERSION_CONFLICT')
 return 'auna-draft-v1:'+match[1].toLowerCase()
}
function mutationInputHash(type,id,action,input,version){return createHash('sha256').update(JSON.stringify(canonical({type,id,action,input,version}))).digest('hex')}
module.exports={parseMutationInput,parseIfMatch,mutationInputHash}
