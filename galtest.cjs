require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
cloudinary.config({ cloud_name:process.env.CLOUDINARY_CLOUD_NAME, api_key:process.env.CLOUDINARY_API_KEY, api_secret:process.env.CLOUDINARY_API_SECRET });
const API = 'https://ma-dsnz.onrender.com';
const PW = process.env.ADMIN_PASSWORD || 'Mahsan2026!';

async function waitRedeploy(){
  for(let i=0;i<20;i++){
    try{
      const g = await (await fetch(API+'/api/products?t='+Date.now())).json();
      const p = (g.products||[])[0];
      if(p && Array.isArray(p.images)){ console.log('backend live (images[] present) try',i+1); return true; }
    }catch(e){}
    console.log('waiting redeploy...',i+1); await new Promise(r=>setTimeout(r,15000));
  }
  return false;
}

(async()=>{
  if(!(await waitRedeploy())){ console.log('redeploy timeout'); return; }

  // 1) demo: give "אדמת חמרה מנופה" 3 images (direct sheet) — pipe-joined
  const auth=new JWT({ email:process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key:(process.env.GOOGLE_PRIVATE_KEY||'').replace(/\\n/g,'\n'), scopes:['https://www.googleapis.com/auth/spreadsheets'] });
  const doc=new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID,auth); await doc.loadInfo();
  const sheet=doc.sheetsByIndex[0]; await sheet.loadHeaderRow();
  const imgCol=(sheet.headerValues||[]).find(h=>h.toLowerCase()==='imageurl')||'imageUrl';
  const urls=[];
  for(const lock of [101,102,103]){ const r=await cloudinary.uploader.upload(`https://loremflickr.com/600/450/soil,garden?lock=${lock}`,{folder:'mahsan-hagadol/demo'}); urls.push(r.secure_url); }
  const rows=await sheet.getRows();
  const row=rows.find(x=>x.get('name')==='אדמת חמרה מנופה');
  if(row){ row.set(imgCol, urls.join(' | ')); await row.save(); console.log('demo product set to 3 images'); }

  // 2) test the multipart upload path with a throwaway product (2 images)
  const buf1=Buffer.from(await (await fetch(urls[0])).arrayBuffer());
  const buf2=Buffer.from(await (await fetch(urls[1])).arrayBuffer());
  const fd=new FormData();
  fd.append('name','__TEST_GALLERY__'); fd.append('world','garden'); fd.append('price','1'); fd.append('desc','test'); fd.append('status','hidden');
  fd.append('images', new Blob([buf1],{type:'image/jpeg'}), 'a.jpg');
  fd.append('images', new Blob([buf2],{type:'image/jpeg'}), 'b.jpg');
  const res=await fetch(API+'/api/products',{method:'POST',headers:{'Authorization':'Bearer '+PW},body:fd});
  const d=await res.json();
  console.log('upload test → ok:', d.ok, '| images count:', d.product && d.product.images ? d.product.images.length : 'n/a');
  // cleanup the test product
  if(d.ok && d.product){ const del=await fetch(API+'/api/products/'+encodeURIComponent(d.product.id)+'?permanent=1',{method:'DELETE',headers:{'Authorization':'Bearer '+PW}}); console.log('cleanup:', (await del.json()).ok); }

  // 3) verify GET shows חמרה with 3 images
  const g=await (await fetch(API+'/api/products?t='+Date.now())).json();
  const hamra=g.products.find(p=>p.name==='אדמת חמרה מנופה');
  console.log('חמרה images via API:', hamra ? hamra.images.length : 'not found');
})();
