const STANDARD_UNITS=Object.freeze([
  ['UNIT','COUNT','Unidad','ud','1',0],
  ['DOCENA','COUNT','Docena','doc','12',0],
  ['KG','MASS','Kilogramo','kg','1',6],
  ['G','MASS','Gramo','g','0.001',6],
  ['LB','MASS','Libra','lb','0.45359237',6],
  ['L','VOLUME','Litro','l','1',6],
  ['ML','VOLUME','Mililitro','ml','0.001',6],
  ['M','LENGTH','Metro','m','1',6],
  ['CM','LENGTH','Centímetro','cm','0.01',6],
  ['MM','LENGTH','Milímetro','mm','0.001',6],
  ['M2','AREA','Metro cuadrado','m²','1',6],
  ['CM2','AREA','Centímetro cuadrado','cm²','0.0001',6],
  ['MIN','TIME','Minuto','min','1',4],
  ['H','TIME','Hora','h','60',4],
  ['SESSION','SESSION','Sesión','sesión','1',4],
  ['WORK','WORK','Trabajo','trabajo','1',4],
  ['VISIT','VISIT','Visita','visita','1',4],
  ['EVENT','EVENT','Evento','evento','1',4],
])
async function seedStandardUnits(tx,companyId) {
  if(!companyId)throw Object.assign(new Error('Empresa requerida'),{status:400})
  await tx.measureUnit.createMany({data:STANDARD_UNITS.map(([code,family,name,label,factor,quantity_decimals])=>({company_id:companyId,code,family,name,label,factor,quantity_decimals,is_standard:true,active:true})),skipDuplicates:true})
}
module.exports={seedStandardUnits}
