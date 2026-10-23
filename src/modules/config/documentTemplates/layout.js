function documentError(code,message){return Object.assign(new Error(message),{code,status:422})}

// Every cell is measured in its final font and width before anything is drawn.
function createFlow(doc,{width,height,margin,font,fontBold,fontSize,color,accent,spacing,maxPages,deadline,preview,pageHeights,thermal=false,monochrome=false}) {
  let pageCount=0,y=0
  const measuredHeights=[]
  const usable=width-2*margin,bottom=height-margin-(thermal?0:24)
  const stroke=monochrome?'#999999':'#d5dbe1',border=monochrome?'#888888':'#c6ced8',rowStroke=monochrome?'#cccccc':'#e8ebef'
  const timeCheck=()=>{if(Date.now()>deadline)throw documentError('DOCUMENT_TIMEOUT','El documento excedió el tiempo de generación')}
  const usedHeight=()=>Math.min(height,Math.max(80,y+margin+(thermal?0:24)))
  function page(){timeCheck();if(pageCount)measuredHeights.push(usedHeight());if(++pageCount>maxPages)throw documentError('DOCUMENT_PAGE_LIMIT',`El documento supera ${maxPages} páginas`);doc.addPage({size:[width,pageHeights?.[pageCount-1]||height],margin:0});y=margin;if(thermal&&pageCount>1){doc.font(fontBold).fontSize(8).fillColor(color).text(preview?'MUESTRA · NO FISCAL':`Continúa · página ${pageCount}`,margin,y,{width:usable,lineBreak:false});y+=14}}
  function measure(text,w=usable,size=fontSize,bold=false) {
    doc.font(bold?fontBold:font).fontSize(size)
    return Math.max(size*1.2,doc.heightOfString(text,{width:w,lineGap:2}))
  }
  function ensure(h){timeCheck();if(h>bottom-margin)throw documentError('DOCUMENT_ROW_TOO_TALL','Un renglón o bloque es más alto que la página; acorta el texto');if(y+h>bottom)page()}
  function text(value,{bold=false,size=fontSize,align='left',color:ink=color,gap=spacing}={}) {
    const str=String(value??'');if(!str)return
    const h=measure(str,usable,size,bold);ensure(h)
    doc.font(bold?fontBold:font).fontSize(size).fillColor(ink).text(str,margin,y,{width:usable,lineGap:2,align})
    y+=h+gap
  }
  function rule(){ensure(thermal?6:8);doc.strokeColor(thermal?'#000000':stroke).lineWidth(.5);if(thermal)doc.dash(2,{space:1.5});doc.moveTo(margin,y).lineTo(width-margin,y).stroke();if(thermal)doc.undash();y+=thermal?6:8}
  function pair(left,right,{bold=false,size=fontSize,total=false,summary=false,labelRatio=.62}={}) {
    const area=summary?Math.min(usable,230):usable,x=margin+usable-area,leftWidth=area*labelRatio,rightWidth=area-leftWidth-8,h=Math.max(measure(left,leftWidth-2,size,bold),measure(right,rightWidth-2,size,bold)),filled=total&&width>300
    ensure(h+spacing+(total?8:0))
    if(total){if(filled)doc.rect(x,y-2,area,h+8).fill(accent);y+=2}
    doc.font(bold?fontBold:font).fontSize(size).fillColor(filled?'#ffffff':color)
    doc.text(left,x+2,y,{width:leftWidth-2,lineGap:2});doc.text(right,x+leftWidth+8,y,{width:rightWidth-2,lineGap:2,align:'right'})
    y+=h+spacing+(total?4:0)
  }
  function letterHeader(data,title,logo) {
    const rightWidth=Math.min(208.8,usable*.43),leftWidth=usable-rightWidth-16,rightX=width-margin-rightWidth,pad=8,logoWidth=logo?64:0,textWidth=leftWidth-logoWidth
    const issuer=[{text:data.emitter.name,bold:true,size:14},...[data.emitter.nit&&`NIT: ${data.emitter.nit}`,data.emitter.address,data.emitter.branch].filter(Boolean).map(text=>({text,size:fontSize}))]
    const fiscal=data.purpose==='FEL_INVOICE',details=[fiscal?'DOCUMENTO TRIBUTARIO ELECTRÓNICO':'DOCUMENTO DE VENTA',`Referencia: ${data.saleReference}`,`Emisión: ${data.issuedAt.slice(0,10)}`,...(fiscal?[`Serie: ${data.fiscal.series||'MUESTRA'}`,`No. DTE: ${data.fiscal.number||'MUESTRA'}`,`Autorización: ${data.fiscal.authorization||'MUESTRA · PENDIENTE DE CERTIFICACIÓN'}`]:[])]
    const titleHeight=measure(title,rightWidth-2*pad,11,true)+12
    const boxHeight=titleHeight+pad+details.reduce((h,t)=>h+measure(t,rightWidth-2*pad,9)+3,0)
    const issuerHeight=issuer.reduce((h,r)=>h+measure(r.text,textWidth,r.size,r.bold)+4,0),height=Math.max(logo?48:0,issuerHeight,boxHeight)
    ensure(height+spacing);const top=y
    if(logo)doc.image(logo,margin,top,{fit:[54,48]})
    let lineY=top
    for(const row of issuer){doc.font(row.bold?fontBold:font).fontSize(row.size).fillColor(color).text(row.text,margin+logoWidth,lineY,{width:textWidth,lineGap:2});lineY+=measure(row.text,textWidth,row.size,row.bold)+4}
    doc.rect(rightX,top,rightWidth,boxHeight).lineWidth(.8).strokeColor(accent).stroke()
    doc.rect(rightX,top,rightWidth,titleHeight).fill(accent)
    doc.font(fontBold).fontSize(11).fillColor('#ffffff').text(title,rightX+pad,top+6,{width:rightWidth-2*pad,lineGap:2,align:'center'})
    lineY=top+titleHeight+pad
    for(const value of details){doc.font(font).fontSize(9).fillColor(color).text(value,rightX+pad,lineY,{width:rightWidth-2*pad,lineGap:2});lineY+=measure(value,rightWidth-2*pad,9)+3}
    y=top+height+spacing+8
  }
  function receiverBox(receiver,currency) {
    const lines=[`NIT: ${receiver.nit||'CF'} · Moneda: ${currency==='Q'?'GTQ':currency}`,`Nombre: ${receiver.name}`],h=lines.reduce((sum,t)=>sum+measure(t,usable-16)+3,0)+14
    ensure(h+spacing);doc.rect(margin,y,usable,h).lineWidth(.5).strokeColor(border).stroke();y+=7
    for(const line of lines){doc.font(font).fontSize(fontSize).fillColor(color).text(line,margin+8,y,{width:usable-16,lineGap:2});y+=measure(line,usable-16)+3}
    y+=7+spacing
  }
  function table(lines,columns,ticket,reference=false,currency='Q',columnStyles={},hasDiscount=false) {
    columns=columns.filter(c=>columnStyles[c]?.when!=='HAS_DISCOUNT'||hasDiscount)
    const labels={number:'No.',description:'DESCRIPCIÓN',quantity:reference?'CANT.':'CANTIDAD',unit:'UNIDAD',price:reference?'P. UNITARIO':'PRECIO',discount:'DESCUENTO',total:reference?'TOTAL':'IMPORTE'}
    const weights=columns.includes('number')?{number:.04,quantity:.17,description:.38,unit:.09,price:.15,discount:.12,total:.14}:{description:.44,quantity:.16,unit:.09,price:.15,total:.16,number:.04,discount:.12}
    for(const [key,style] of Object.entries(columnStyles)){if(style.label!==undefined)labels[key]=style.label;if(style.width!==undefined)weights[key]=style.width/100}
    const sum=reference?columns.reduce((n,c)=>n+weights[c],0):1,widths=columns.map(c=>usable*weights[c]/sum),padding=4
    const header=()=>{
      if(ticket){if(reference)pair('CANT DESCRIPCIÓN','TOTAL',{bold:true,size:fontSize,labelRatio:.7});else text('DETALLE',{bold:true,color:accent});return}
      const h=Math.max(...columns.map((c,i)=>measure(labels[c],widths[i]-padding,fontSize-1,true)))+8
      ensure(h);let x=margin
      doc.rect(margin,y,usable,h).fill(reference?accent:'#f1f4f7')
      columns.forEach((c,i)=>{doc.font(fontBold).fontSize(fontSize-1).fillColor(reference?'#ffffff':color).text(labels[c],x+2,y+4,{width:widths[i]-padding,lineGap:2,...(columnStyles[c]?.align?{align:columnStyles[c].align}:{})});x+=widths[i]})
      y+=h+4
    }
    header()
    for(const [index,line] of lines.entries()) {
      timeCheck()
      if(ticket) {
        if(reference){
          const unit=/^(ud|unidad|unidades)$/i.test(line.unit)?'':` ${line.unit}`,detail=`${line.quantity}${unit} x ${currency} ${line.price}`,total=`${currency} ${line.total}`,h=measure(line.name)+Math.max(measure(detail,usable*.7),measure(total,usable*.3-8))+spacing+5
          if(h>bottom-margin-36)throw documentError('DOCUMENT_ROW_TOO_TALL','Un renglón es más alto que una página; acorta su descripción')
          if(y+h>bottom){ensure(h+28);header()}
          ensure(h);text(line.name,{gap:1});pair(detail,total,{labelRatio:.7});continue
        }
        const detail=`${line.quantity} ${line.unit} × ${line.price}     ${line.total}`
        const h=measure(line.name)+measure(detail)+spacing+8
        if(y+h>bottom){ensure(h);header()}
        ensure(h);text(line.name,{bold:true,gap:2});text(detail,{gap:spacing+4})
      } else {
        const values={number:String(index+1),description:line.name,quantity:`${line.quantity} ${line.unit}`,unit:line.unit,price:line.price,discount:line.discount??'—',total:line.total}
        // Quantity includes its unit so that fraction and unit remain adjacent even in reordered columns.
        const h=Math.max(...columns.map((c,i)=>measure(values[c],widths[i]-padding)))+10
        if(h>bottom-margin-36)throw documentError('DOCUMENT_ROW_TOO_TALL','Un renglón es más alto que una página; acorta su descripción')
        if(y+h>bottom){page();header()}
        let x=margin
        columns.forEach((c,i)=>{doc.font(font).fontSize(fontSize).fillColor(color).text(String(values[c]),x+2,y+4,{width:widths[i]-padding,lineGap:2,align:columnStyles[c]?.align||(['price','discount','total'].includes(c)?'right':'left')});x+=widths[i]})
        y+=h
        doc.strokeColor(rowStroke).lineWidth(.3).moveTo(margin,y).lineTo(width-margin,y).stroke()
      }
    }
    if(reference&&!ticket&&columns.includes('number'))for(let n=lines.length;n<12&&y+22<bottom-270;n++){y+=22;doc.strokeColor(rowStroke).lineWidth(.3).moveTo(margin,y).lineTo(width-margin,y).stroke()}
    y+=spacing
  }
  function verification(buffer,lines) {
    const h=Math.max(72,lines.reduce((n,t)=>n+measure(t,usable-86,9)+4,0))+10
    ensure(h);y=Math.max(y,bottom-h);const top=y
    doc.strokeColor(accent).lineWidth(.7).moveTo(margin,top).lineTo(width-margin,top).stroke()
    doc.image(buffer,margin,top+8,{fit:[72,72]});let lineY=top+8
    for(const line of lines){doc.font(font).fontSize(9).fillColor(color).text(line,margin+86,lineY,{width:usable-86,lineGap:2});lineY+=measure(line,usable-86,9)+4}
    y=top+h
  }
  function image(buffer,h=48,align='left') {
    ensure(h+spacing);doc.image(buffer,align==='center'?(width-80)/2:align==='right'?width-margin-80:margin,y,{fit:[80,h],align});y+=h+spacing
  }
  function finish(){
    if(thermal)return
    const {start,count}=doc.bufferedPageRange()
    for(let i=start;i<start+count;i++){
      const actualHeight=pageHeights?.[i]||height
      doc.switchToPage(i);doc.font(font).fontSize(8).fillColor(color).text(`${i+1} / ${count}`,margin,actualHeight-margin-12,{width:usable,align:'right',lineBreak:false})
      if(preview)doc.font(fontBold).fontSize(9).fillColor(color).text('MUESTRA · NO FISCAL',margin,actualHeight-margin-12,{width:usable-36,lineBreak:false})
    }
  }
  page()
  return {text,rule,pair,letterHeader,receiverBox,table,verification,image,ensure,measure,finish,get pageCount(){return pageCount},get pageHeights(){return [...measuredHeights,usedHeight()]},get y(){return y}}
}
module.exports={documentError,createFlow}
