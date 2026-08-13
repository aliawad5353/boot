const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const P = require('pino');
const axios = require('axios');
const https = require('https');

const httpsAgent = new https.Agent({ family: 4, keepAlive: true });
const app = express();
const PORT = process.env.PORT || 3000;
let qrString = null;
let sock = null;

let cachedProducts = null;
const SHEET_CSV_URL = process.env.SHEET_URL || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRBtqGW3UGDuPtr8POlTvfKilCWDlxnd4_rjV3jNbtZd2S-0x-WVjcITJhpsjrFuJB1jsl9zzvKVYMs/pub?output=csv';

// --- تحميل المنتجات من الشيت ---
async function fetchFromSheet(){
  try{
    const res = await axios.get(SHEET_CSV_URL, { timeout: 20000, httpsAgent, headers: {'User-Agent':'Mozilla/5.0'} });
    const lines = res.data.split('\n').filter(l=>l.trim());
    const headers = lines[0].split(',').map(h=>h.trim().toLowerCase().replace(/^"|"$/g,''));
    const products = [];
    for(let i=1;i<lines.length;i++){
      let row = lines[i]; let values=[]; let cur=''; let inQuote=false;
      for(let ch of row){ if(ch=='"'){inQuote=!inQuote; continue;} if(ch==',' &&!inQuote){values.push(cur.trim()); cur='';} else cur+=ch; }
      values.push(cur.trim());
      const obj={}; headers.forEach((h,idx)=> obj[h]=values[idx]||'');
      if(obj.code) products.push({
        code: obj.code.trim().toUpperCase(),
        name: (obj.name||obj.code).trim(),
        category: (obj.category||'رجالي').trim(),
        priceDozen: parseInt((obj.pricedozen||'0').replace(/[^0-9]/g,''))||0,
        image: (obj.image||'').trim()
      });
    }
    if(products.length>0){ cachedProducts=products; console.log(`✅ Sheet: ${products.length}`); return products; }
  }catch(e){ console.log('Sheet Error:', e.message); }
  return cachedProducts;
}
function loadProducts(){ return cachedProducts||[]; }
setInterval(fetchFromSheet, 60*1000);
fetchFromSheet();

// حساب السعر
function getCartonDetails(p){
  const name=(p.name||'').toLowerCase();
  const has2 = name.includes('2 دسته')||name.includes('2 دستة');
  const dozenCount = has2?2:4; const pieces=dozenCount*12;
  return { price: p.priceDozen*dozenCount, dozenCount, pieces, priceDozen:p.priceDozen };
}

const WELCOME_MSG = `🏢 *مرحبا بكم في شركة ابو حريره للاحذية*
الوكيل الحصري لاحذية لوفو بالسودان ⭐

📢 *تنبيه مهم:*
البيع بالكرتونة فقط - لايوجد بيع بالحبة او بالدستة والاسعار نهائية
━━━━━━━━━━━━━━━━
📂 *القائمة الرئيسية:*
1️⃣ 👞 رجالي
2️⃣ 👠 نسائي
3️⃣ 👶 اطفالي
4️⃣ 🧒 صبياني
0️⃣ ❌ خروج
👉 ارسل رقم القسم (مثلا: 1)`;

const sessions={};

async function startBot(){
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  sock = makeWASocket({ auth: state, logger: P({level:'silent'}), browser:["AbuHrira","Chrome","1.0"] });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update)=>{
    const { connection, lastDisconnect, qr } = update;
    if(qr) qrString=qr;
    if(connection==='open'){ console.log('✅ Bot connected'); qrString=null; }
    if(connection==='close'){
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut;
      if(shouldReconnect) startBot();
    }
  });

  sock.ev.on('messages.upsert', async ({messages})=>{
    const m=messages[0]; if(!m.message||m.key.fromMe) return;
    const from=m.key.remoteJid;
    let text=m.message.conversation||m.message.extendedTextMessage?.text||''; text=text.trim();
    const lower=text.toLowerCase();
    if(!sessions[from]) sessions[from]={step:'start'};
    const session=sessions[from];
    const products=loadProducts();

    // رجوع للقائمة
    if(lower==='القائمة'||lower==='0'){ sessions[from]={step:'start'}; await sock.sendMessage(from,{text:WELCOME_MSG}); return; }

    // 1- البحث بكود مباشر في اي وقت
    let directProduct = products.find(p=> lower.includes(p.code.toLowerCase()));
    if(directProduct && text.length < 20){
      const det=getCartonDetails(directProduct);
      session.product=directProduct; session.step='ask_qty';
      const caption=`✅ *${directProduct.name}*\nالكود: ${directProduct.code}\nالقسم: ${directProduct.category}\nالكرتونة: ${det.dozenCount} دستة (${det.pieces} حبة)\nسعر الكرتونة: *${det.price.toLocaleString()} جنيه*\nسعر الدستة: ${det.priceDozen.toLocaleString()} جنيه`;
      try{
        if(directProduct.image) await sock.sendMessage(from,{image:{url:directProduct.image}, caption});
        else await sock.sendMessage(from,{text:caption});
      }catch{ await sock.sendMessage(from,{text:caption}); }
      await sock.sendMessage(from,{text:`كم كرتونة من هذا الصنف *${directProduct.name}* تريد؟`});
      return;
    }

    if(session.step==='start'){
      sessions[from].step='choose_category';
      await sock.sendMessage(from,{text:WELCOME_MSG}); return;
    }

    // 2- عرض الاقسام - التعديل المطلوب هنا
    if(session.step==='choose_category'){
      let cat=null; let isAll=false;
      if(text==='1'||lower.includes('رجالي')) cat='رجالي';
      else if(text==='2'||lower.includes('نسائي')) cat='نسائي';
      else if(text==='3'||lower.includes('اطفالي')) cat='اطفالي';
      else if(text==='4'||lower.includes('صبياني')) cat='صبياني';
      else if(text==='5') isAll=true;

      if(cat||isAll){
        const filtered = isAll? products : products.filter(p=> p.category===cat);
        if(filtered.length===0){ await sock.sendMessage(from,{text:`لا يوجد اصناف في ${cat}`}); return; }

        session.lastCategory=cat; session.step='choose_product';
        await sock.sendMessage(from,{text:`📦 *اصناف ${isAll?'كل الاصناف':cat}* - ${filtered.length} صنف\nسأعرضها لك بنفس طريقة عرض الكود...`});

        // هذا هو طلبك: عرض كل صنف بصورة وتفاصيله كاملة
        for(let p of filtered){
          const det=getCartonDetails(p);
          const cap=`✅ *${p.name}*\nالكود: ${p.code}\nالقسم: ${p.category}\nالكرتونة: ${det.dozenCount} دستة (${det.pieces} حبة)\nسعر الكرتونة: *${det.price.toLocaleString()} جنيه*`;
          try{
            if(p.image) await sock.sendMessage(from,{image:{url:p.image}, caption:cap});
            else await sock.sendMessage(from,{text:cap});
          }catch(e){ await sock.sendMessage(from,{text:cap}); }
          await new Promise(r=>setTimeout(r, 1000));
        }
        await sock.sendMessage(from,{text:`👆 هذه كل اصناف ${cat}\nالآن ارسل كود الصنف الذي تريده لطلبه`});
        return;
      }
    }

    // 3- استلام عدد الكراتين - التعديل المطلوب
    if(session.step==='ask_qty'){
      const qty=parseInt(text.replace(/[^0-9]/g,''));
      if(isNaN(qty)||qty<=0){ await sock.sendMessage(from,{text:`❌ ارسل عدد الكراتين كرقم مثلا: 2`}); return; }
      const prod=session.product; const det=getCartonDetails(prod);
      const total=det.price*qty; session.qty=qty; session.total=total; session.step='confirm';
      await sock.sendMessage(from,{text:`🧾 *فاتورة مبدئية - شركة ابو حريره*\n━━━━━━━━━━━━━━━━\nالصنف: ${prod.name}\nالكود: ${prod.code}\nالقسم: ${prod.category}\nالكرتونة: ${det.dozenCount} دستة (${det.pieces} حبة)\nسعر الكرتونة: ${det.price.toLocaleString()} جنيه\nعدد الكراتين: ${qty}\n━━━━━━━━━━━━━━━━\n*💰 الإجمالي: ${total.toLocaleString()} جنيه*\n━━━━━━━━━━━━━━━━\nالبيع بالكرتونة فقط\n\n✅ للتأكيد ارسل *نعم*\n❌ للالغاء ارسل *0*`});
      return;
    }

    // 4- التأكيد النهائي - التعديل المطلوب الثاني
    if(session.step==='confirm' && (lower.includes('نعم')||lower==='yes')){
      await sock.sendMessage(from,{text:`✅ *تم تأكيد طلبك بنجاح!*\n\n💳 *بيانات السداد عبر بنكك:*\nرقم الحساب: *2392448*\nباسم: *الشيخ السراج المامون الشيخ*\nالمبلغ المطلوب: *${session.total.toLocaleString()} جنيه*\n📦 الطلب: ${session.product.name} (${session.qty} كرتونة)\n\n📸 *بعد التحويل أرسل:*\n1. صورة إشعار التحويل\n2. اسمك الثلاثي\n3. الجهة التي تريد ترحيل البضاعة اليها والترحيلات\n4. رقم هاتفك\n\n🏢 *شركة ابو حريره*`});
      sessions[from]={step:'start'}; return;
    }
  });
}

app.get('/', async (req,res)=>{
  if(sock?.user) return res.send(`<h1>✅ البوت شغال ${sock.user.id} - المنتجات ${loadProducts().length}</h1>`);
  if(!qrString) return res.send('<h1>جاري توليد QR...</h1><meta http-equiv="refresh" content="2">');
  const qrImg=await QRCode.toDataURL(qrString);
  res.send(`<center><img src="${qrImg}" width="300"><p>امسح بواتساب الشركة</p><script>setTimeout(()=>location.reload(),4000)</script></center>`);
});
app.listen(PORT, ()=> console.log(PORT));
startBot();
