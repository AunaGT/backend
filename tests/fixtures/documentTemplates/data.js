function sampleData(count=1) {
  return {schemaVersion:1,purpose:'INTERNAL_RECEIPT',issuedAt:'2026-10-22T12:00:00.000Z',saleReference:'V-00042',
    emitter:{name:'Café del Valle',nit:'123456-7',address:'Guatemala',branch:'Principal'},receiver:{name:'María López',nit:'CF'},
    lines:Array.from({length:count},(_,i)=>({name:`Artículo ${i+1} — Café especial`,quantity:'0.123456',unit:'kg',price:'18.90',total:'2.33'})),
    totals:{subtotal:'18.90',discount:'0.00',total:'18.90',currency:'Q'},paymentAtPreparation:{method:'Efectivo'},notices:['Comprobante interno. No constituye factura fiscal.'],fiscal:null}
}
module.exports={sampleData}
