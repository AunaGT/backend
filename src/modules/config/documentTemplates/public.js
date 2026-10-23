const {schemaManifest}=require('./contract')
const {compileTemplate}=require('./xml')
const {resolveBase,freezeProfile}=require('./presets')
const {renderDocument}=require('./render')
module.exports={schemaManifest,compileTemplate,resolveBase,freezeProfile,renderDocument}
