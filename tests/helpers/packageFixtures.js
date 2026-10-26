const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function definition() {
  return {
    schemaVersion: 1, name: 'Paquete de evento', description: 'Productos y atención', imageUrl: null, currency: 'GTQ',
    variants: [{id:id(1), name:'160 unidades', price:'1599.00',
      components:[{id:id(2), productId:id(20), quantity:'1', presentationId:null, unitRevision:1, weight:'20'}],
      choices:[{id:id(3), name:'Sabores', totalQuantity:'160', maxDistinct:2, weight:'80',
        options:[21,22,23].map((n,i)=>({id:id(4+i), productId:id(n), presentationId:null, unitRevision:1}))}]}],
  }
}
function selection(items=[{optionId:id(4),quantity:'80'},{optionId:id(5),quantity:'80'}]) {
  return {groupId:id(100), packageId:id(101), version:1, variantId:id(1), choices:[{choiceId:id(3),items}]}
}
function leaf(n, quantity='1', weight='1', allocationId=id(n)) {
  return {key:`${id(100)}:${id(n)}`, quantity, weight, allocationId}
}
module.exports={id, definition, selection, leaf}
