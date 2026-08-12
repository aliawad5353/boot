
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const P = require('pino');
const axios = require('axios');
const https = require('https');

// ✅ اجبار الاتصال IPv4 فقط لحل مشكلة ETIMEDOUT في Render
const httpsAgent = new https.Agent({ family: 4, keepAlive: true });

const app = express();
const PORT = process.env.PORT || 3000;
let qrString = null;
let sock = null;

let cachedProducts = null;
let lastFetch = 0;
// ✅ المصدر الوحيد للأكواد والأسعار والصور هو Google Sheet
// الشيت بتاعك: اسعار شركة ابو حريره
const SHEET_CSV_URL = process.env.SHEET_URL || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRBtqGW3UGDuPtr8POlTvfKilCWDlxnd4_rjV3jNbtZd2S-0x-WVjcITJhpsjrFuJB1jsl9zzvKVYMs/pub?output=csv';

async function fetchFromSheet(retries=3){
  if(!SHEET_CSV_URL) return null;
  for(let attempt=1; attempt<=retries; attempt++){
    try{
      const res = await axios.get(SHEET_CSV_URL, { 
        timeout: 20000,
        httpsAgent: httpsAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'text/csv, text/plain, */*'
        }
      });
      const lines = res.data.split('\n').filter(l=>l.trim());
      if(lines.length < 2){
        console.log('Sheet empty or no data');
        return null;
      }
      const headers = lines[0].split(',').map(h=>h.trim().toLowerCase().replace(/^"|"$/g,''));
      const products = [];
      for(let i=1;i<lines.length;i++){
        let row = lines[i];
        let values = [];
        let cur = '';
        let inQuote = false;
        for(let ch of row){
          if(ch=='"'){ inQuote=!inQuote; continue; }
          if(ch==',' && !inQuote){ values.push(cur.trim()); cur=''; } else cur+=ch;
        }
        values.push(cur.trim());
        const obj = {};
        headers.forEach((h,idx)=> obj[h]=values[idx]||'');
        if(obj.code && obj.code.trim()){
          products.push({
            code: obj.code.trim().toUpperCase(),
            name: (obj.name || obj.code).trim(),
            category: (obj.category || 'رجالي').trim(),
            priceDozen: parseInt((obj.pricedozen || obj.price || '0').replace(/[^0-9]/g,'')) || 0,
            image: (obj.image || '').trim()
          });
        }
      }
      if(products.length>0){
        console.log(`✅ Sheet loaded: ${products.length} products (attempt ${attempt})`);
        return products;
      }
      return null;
    }catch(e){
      console.log(`⚠️ Sheet fetch attempt ${attempt}/${retries} failed: ${e.message}`);
      if(attempt < retries){
        await new Promise(r=> setTimeout(r, 2000*attempt));
        continue;
      }
      console.log('Sheet fetch error final:', e.message);
      // لا ترجع null لو في كاش قديم
      return null;
    }
  }
  return null;
}

function loadProducts(){
  // الأولوية 1: الكاش من Google Sheet (الأكواد الحقيقية E6208-E01 الخ)
  if(cachedProducts && cachedProducts.length>0) return cachedProducts;
  // الأولوية 2: ملف الكاش products.json (اللي بتمليه من الشيت تلقائي)
  try{ 
    const local = JSON.parse(fs.readFileSync('./products.json','utf8'));
    // لو الملف فيه بيانات حقيقية من الشيت (مو LV-R01 القديمة)
    if(local && local.length>0){
      // لو أول كود يبدأ ب E أو فيه - مثل أكوادكم الحقيقية
      const isRealData = local[0].code && (local[0].code.includes('-') || local[0].code.startsWith('E'));
      if(isRealData || local.length>5){
        if(!cachedProducts) cachedProducts = local;
        return local;
      }
    }
  }catch(e){}
  return cachedProducts || [];
}

// تحديث كل دقيقة
setInterval(async ()=>{
  const sheetProducts = await fetchFromSheet();
  if(sheetProducts && sheetProducts.length>0){
    cachedProducts = sheetProducts;
    lastFetch = Date.now();
    fs.writeFileSync('./products.json', JSON.stringify(sheetProducts, null, 2), 'utf8');
    console.log(`✅ تم تحديث ${sheetProducts.length} منتج من Google Sheet`);
  }
}, 60*1000);

(async ()=>{
  const sheetProducts = await fetchFromSheet();
  if(sheetProducts && sheetProducts.length>0){
    cachedProducts = sheetProducts;
    lastFetch = Date.now();
    fs.writeFileSync('./products.json', JSON.stringify(sheetProducts, null, 2), 'utf8');
  }
})();

// ======== حساب السعر الذكي 2 دستة و 4 دستة - حسب طلب العميل ========
// السعر في الشيت هو سعر الدستة الواحدة
// لو الاسم فيه 2 دسته => سعر الكرتونة = priceDozen * 2
// لو الاسم فيه 4 دسته => سعر الكرتونة = priceDozen * 4
function getCartonDetails(product){
  const name = (product.name||'').toLowerCase();
  const has2 = name.includes('2 دسته') || name.includes('2 دستة') || name.includes('2دسته') || name.includes('2دستة');
  const dozenCount = has2 ? 2 : 4;
  const pieces = dozenCount * 12;
  const priceDozen = parseInt(product.priceDozen)||0;
  const price = priceDozen * dozenCount; // سعر الكرتونة
  return { price, dozenCount, pieces, priceDozen };
}

// ======== رسائل احترافية مثل زين ========
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
5️⃣ 📦 عرض كل الاصناف
0️⃣ ❌ خروج

👉 ارسل رقم القسم (مثلا: 1)`;

const HELP_MSG = `ℹ️ *للمساعدة:*
• ارسل رقم القسم: 1-5
• ارسل كود الصنف مباشرة: LV-R01
• ارسل *القائمة* للرجوع للقائمة الرئيسية
• ارسل *0* للخروج`;

const sessions = {};

async function startBot(){
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  sock = makeWASocket({ auth: state, logger: P({level:'silent'}) });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update)=>{
    const { connection, lastDisconnect, qr } = update;
    if(qr) qrString = qr;
    if(connection === 'open'){ console.log('✅ Bot connected - ابو حريره شغال'); qrString = null; }
    if(connection === 'close'){
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if(shouldReconnect) startBot();
    }
  });

  sock.ev.on('messages.upsert', async ({messages})=>{
    const m = messages[0];
    if(!m.message || m.key.fromMe) return;
    const from = m.key.remoteJid;
    let text = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.buttonsResponseMessage?.selectedDisplayText || '';
    text = text.trim();
    const lower = text.toLowerCase();
    console.log('From', from, 'Text', text);

    if(!sessions[from]) sessions[from] = { step:'start', lastCategory:null };
    const session = sessions[from];
    const products = loadProducts();

    // اوامر عامة
    if(lower === 'القائمة' || lower === 'قائمة' || lower === 'menu' || lower === '0' && session.step==='start'){
      session.step='start';
    }
    if(lower === '0' && session.step!=='start'){
      sessions[from]={step:'start'};
      await sock.sendMessage(from, { text: WELCOME_MSG });
      return;
    }

    // البحث عن كود من الموقع (مثلا: الموقع بيرسل رابط فيه كود)
    let codeMatch = text.match(/(LV-[A-Z0-9\-]+)/i) || text.match(/([A-Z]+\d+[A-Z0-9\-]*)/i);
    let foundProduct = null;
    if(codeMatch){
      let c = codeMatch[1].toUpperCase();
      foundProduct = products.find(p=> p.code.toUpperCase() === c || c.includes(p.code.toUpperCase()));
    }

    // ====== بداية المحادثة - مثل شركات الاتصالات ======
    if(session.step==='start' || lower.includes('سلام') || lower.includes('مرحب') || lower.includes('hi') || lower.includes('hello') || text==='1' && !foundProduct){
      if(foundProduct){
        const det = getCartonDetails(foundProduct);
        session.product = foundProduct;
        session.step = 'ask_qty';
        const caption = `✅ *${foundProduct.name}*
`+
        `🔹 الكود: ${foundProduct.code}
`+
        `🔹 القسم: ${foundProduct.category}
`+
        `🔹 الكرتونة: ${det.dozenCount} دستة - ${det.pieces} حبة
`+
        `💰 *سعر الكرتونة: ${det.price.toLocaleString()} جنيه*
`+
        `💵 سعر الدستة: ${det.priceDozen.toLocaleString()} جنيه
`+
        `⚠️ البيع بالكرتونة فقط - نهائي

`+
        `📦 *كم كرتونة تريد؟*
ارسل العدد (مثلا: 2)`;
        
        const img = extractImageUrl(text) || foundProduct.image;
        if(img && img.startsWith('http')){
          try{ await sock.sendMessage(from, { image: { url: img }, caption }); }
          catch(e){ await sock.sendMessage(from, { text: caption }); }
        } else {
          await sock.sendMessage(from, { text: caption });
        }
        return;
      }

      session.step='choose_category';
      await sock.sendMessage(from, { text: WELCOME_MSG });
      return;
    }

    // ====== اختيار القسم ======
    if(session.step === 'choose_category'){
      let category = null;
      let isAll = false;
      const t = text.trim();
      
      if(t==='1' || lower.includes('رجالي') || lower==='👞') category='رجالي';
      else if(t==='2' || lower.includes('نسائي') || lower==='👠') category='نسائي';
      else if(t==='3' || lower.includes('اطفالي') || lower.includes('أطفالي') || lower==='👶') category='اطفالي';
      else if(t==='4' || lower.includes('صبياني') || lower==='🧒') category='صبياني';
      else if(t==='5' || lower.includes('كل') || t==='all') isAll=true;

      // بحث مباشر بكود
      let direct = products.find(p=> p.code.toLowerCase() === lower || lower.includes(p.code.toLowerCase()));
      if(direct){
        const det = getCartonDetails(direct);
        session.product = direct;
        session.step='ask_qty';
        const caption = `✅ *${direct.name}*
الكود: ${direct.code}
القسم: ${direct.category}
الكرتونة: ${det.dozenCount} دستة (${det.pieces} حبة)
سعر الكرتونة: *${det.price.toLocaleString()} جنيه*

كم كرتونة؟`;
        if(direct.image){
          try{ await sock.sendMessage(from, { image:{url:direct.image}, caption }); }
          catch{ await sock.sendMessage(from, { text: caption }); }
        } else await sock.sendMessage(from, { text: caption });
        return;
      }

      if(category || isAll){
        let filtered = isAll ? products : products.filter(p=> p.category === category);
        if(filtered.length===0){
          await sock.sendMessage(from, { text: `😔 لا يوجد منتجات في قسم ${category} حاليا\n\n${HELP_MSG}` });
          return;
        }
        session.lastCategory = isAll ? 'all' : category;
        session.lastFiltered = filtered.map(p=>p.code);
        session.step='choose_product';

        // ملخص احترافي
        let summary = `📦 *قسم ${isAll?'كل الاصناف':category}* - ${filtered.length} موديل
`;
        summary += `━━━━━━━━━━━━━━━━
`;
        filtered.slice(0,15).forEach((p,i)=>{
          const det = getCartonDetails(p);
          summary+= `${i+1}. ${p.code} - ${p.name} | ${det.price.toLocaleString()} جنيه (${det.dozenCount} دستة)
`;
        });
        if(filtered.length>15) summary+= `... و ${filtered.length-15} موديل اخر
`;
        summary+= `━━━━━━━━━━━━━━━━
`;
        summary+= `👉 *اختر:*
`;
        summary+= `• ارسل رقم الموديل (1-${Math.min(filtered.length,15)}) لعرض صورته
`;
        summary+= `• ارسل كود الصنف مباشرة (مثلا: ${filtered[0].code})
`;
        summary+= `• ارسل *الصور* لعرض كل الصور مع الاسعار
`;
        summary+= `• ارسل *0* للقائمة الرئيسية`;

        await sock.sendMessage(from, { text: summary });
        return;
      } else {
        await sock.sendMessage(from, { text: `❌ اختيار غير صحيح

${WELCOME_MSG}` });
        return;
      }
    }

    // ====== اختيار منتج ======
    if(session.step === 'choose_product'){
      let filtered = session.lastCategory==='all' ? loadProducts() : loadProducts().filter(p=> p.category===session.lastCategory);
      
      // لو ارسل رقم
      let num = parseInt(text);
      if(!isNaN(num) && num>=1 && num<=filtered.length){
        let p = filtered[num-1];
        const det = getCartonDetails(p);
        session.product=p;
        session.step='ask_qty';
        const caption = `✅ *${p.name}*
الكود: ${p.code}
القسم: ${p.category}
الكرتونة: ${det.dozenCount} دستة - ${det.pieces} حبة
سعر الكرتونة: *${det.price.toLocaleString()} جنيه*
البيع بالكرتونة فقط

كم كرتونة؟`;
        if(p.image){
          try{ await sock.sendMessage(from, { image:{url:p.image}, caption }); }
          catch{ await sock.sendMessage(from, { text: caption }); }
        } else await sock.sendMessage(from, { text: caption });
        return;
      }

      // لو ارسل كود
      let p = products.find(x=> x.code.toLowerCase() === lower || lower.includes(x.code.toLowerCase()));
      if(p){
        const det = getCartonDetails(p);
        session.product=p;
        session.step='ask_qty';
        const caption = `✅ *${p.name}* (${p.code})
الكرتونة: ${det.dozenCount} دستة - ${det.pieces} حبة
سعر الكرتونة: *${det.price.toLocaleString()} جنيه*

كم كرتونة داير؟`;
        if(p.image){
          try{ await sock.sendMessage(from, { image:{url:p.image}, caption }); }
          catch{ await sock.sendMessage(from, { text: caption }); }
        } else await sock.sendMessage(from, { text: caption });
        return;
      }

      // لو طلب عرض كل الصور
      if(lower.includes('الصور') || lower.includes('صور') || text==='*'){
        await sock.sendMessage(from, { text: `📸 سأرسل ${filtered.length} صورة بالأسعار... انتظر` });
        for(let prod of filtered.slice(0,20)){ // حد اقصى 20 عشان ما يحظر
          const det = getCartonDetails(prod);
          const caption = `*${prod.name}*
الكود: ${prod.code}
القسم: ${prod.category}
سعر الكرتونة (${det.dozenCount} دستة - ${det.pieces} حبة): *${det.price.toLocaleString()} جنيه*
البيع بالكرتونة فقط
للطلب ارسل: ${prod.code}`;
          if(prod.image && prod.image.startsWith('http')){
            try{
              await sock.sendMessage(from, { image:{url:prod.image}, caption });
              await new Promise(r=> setTimeout(r, 1200));
            }catch(e){
              await sock.sendMessage(from, { text: caption });
            }
          } else {
            await sock.sendMessage(from, { text: caption });
          }
        }
        await sock.sendMessage(from, { text: `✅ انتهى عرض ${filtered.length} موديل

للطلب ارسل كود الحذاء (مثلا: ${filtered[0].code}) أو 0 للقائمة` });
        return;
      }

      await sock.sendMessage(from, { text: `❌ الكود غير صحيح
ارسل رقم (1-${filtered.length}) أو كود مثل ${filtered[0].code}
أو ارسل *الصور* لعرض كل الصور` });
      return;
    }

    // ====== كمية ======
    if(session.step === 'ask_qty'){
      const qty = parseInt(text.replace(/[^0-9]/g,''));
      if(isNaN(qty) || qty<=0){
        await sock.sendMessage(from, { text: `❌ ارسل عدد الكراتين كرقم صحيح مثلا: 2` });
        return;
      }
      const prod = session.product;
      const det = getCartonDetails(prod);
      const total = det.price * qty;
      session.qty=qty;
      session.total=total;
      session.step='confirm';
      await sock.sendMessage(from, { text: `🧾 *فاتورة مبدئية - شركة ابو حريره*
━━━━━━━━━━━━━━━━
الصنف: ${prod.name}
الكود: ${prod.code}
القسم: ${prod.category}
الكرتونة: ${det.dozenCount} دستة (${det.pieces} حبة)
سعر الكرتونة: ${det.price.toLocaleString()} جنيه
عدد الكراتين: ${qty}
━━━━━━━━━━━━━━━━
*💰 الإجمالي: ${total.toLocaleString()} جنيه*
━━━━━━━━━━━━━━━━
البيع بالكرتونة فقط - الاسعار نهائية

✅ للتأكيد ارسل *نعم*
❌ للالغاء ارسل *0*` });
      return;
    }

    if(session.step === 'confirm'){
      if(lower.includes('نعم') || lower.includes('تاكيد') || lower==='yes' || lower==='تأكيد'){
        await sock.sendMessage(from, { text: `✅ *تم تأكيد طلبك بنجاح!*

💳 *بيانات السداد عبر بنكك:*
رقم الحساب: *2392448*
باسم: *الشيخ السراج المامون الشيخ*
المبلغ المطلوب: *${session.total.toLocaleString()} جنيه*

📦 الطلب: ${session.product.name} (${session.qty} كرتونة)

📸 بعد التحويل أرسل:
1. صورة إشعار التحويل
2. اسمك الثلاثي
3. عنوانك + رقم تلفونك للشحن 🚚

🏢 *شركة ابو حريره للاحذية*
الوكيل الحصري لوفو بالسودان
📞 00249120240401
🌐 abuhrira-store.com

شكرا لثقتكم بنا! 🙏` });
        sessions[from]={step:'start'};
      } else if(lower==='0' || lower.includes('لا') || lower.includes('الغاء')){
        sessions[from]={step:'start'};
        await sock.sendMessage(from, { text: `❌ تم إلغاء الطلب

${WELCOME_MSG}` });
      } else {
        await sock.sendMessage(from, { text: `ارسل *نعم* للتأكيد أو *0* للإلغاء` });
      }
    }
  });
}

function extractImageUrl(t){ const m=t.match(/(https?:\/\/[^\s]+\.(?:jpg|jpeg|png|webp))/i); return m?m[0]:null; }

app.get('/', async (req,res)=>{
  if(!qrString){
    if(sock?.user) return res.send(`<html dir=rtl style="font-family:Arial;text-align:center;padding:30px"><h1>✅ بوت ابو حريره شغال!</h1><p>الرقم: ${sock.user.id}</p><p>المنتجات: ${loadProducts().length} - الشيت: ${SHEET_CSV_URL?'مربوط ✅':'غير مربوط'}</p><p><a href="/products">عرض المنتجات</a> | <a href="/status">حالة البوت</a></p></html>`);
    return res.send('<html dir=rtl style="font-family:Arial;text-align:center;padding:40px"><h1>⏳ جاري توليد QR...</h1><p>انتظر 5 ثواني</p><meta http-equiv="refresh" content="2"></html>');
  }
  const qrImg = await QRCode.toDataURL(qrString);
  res.send(`<html dir=rtl><body style="text-align:center;font-family:Arial;padding:20px"><h2>📱 امسح الرمز بواتساب الشركة</h2><p>واتساب > الإعدادات > الأجهزة المرتبطة > ربط جهاز</p><p>رقم الشركة: 00249120240401</p><img src="${qrImg}" width="320" style="border:10px solid #000;border-radius:10px"><p>الصفحة تحدث تلقائي كل 4 ثواني</p><script>setTimeout(()=>location.reload(),4000)</script></body></html>`);
});

app.get('/status', (req,res)=>{
  const p = loadProducts();
  res.json({ connected: !!sock?.user, phone: sock?.user?.id||null, products: p.length, sheet: SHEET_CSV_URL, lastFetch: new Date(lastFetch).toISOString(), categories: [...new Set(p.map(x=>x.category))] });
});

app.get('/products', (req,res)=>{
  const products = loadProducts();
  res.json(products);
});

app.use(express.json());
app.use(express.urlencoded({extended:true}));

app.listen(PORT, ()=> console.log(`🚀 Server ${PORT} - http://localhost:${PORT}`));
startBot();
