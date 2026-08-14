const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 5000;

let latestQR = null;
let isConnected = false;
let sock = null;

// 1. خادم Express لعرض الباركود
app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <div style="text-align: center; font-family: sans-serif; margin-top: 50px;">
                <h1 style="color: #2e7d32;">✅ البوت متصل بالواتساب بنجاح!</h1>
                <p style="font-size: 18px;">سيرفر أبو حريرة يعمل في الخلفية ويستقبل طلبات الزبائن (تدفق كلمة "لا").</p>
            </div>
        `);
    }

    if (latestQR) {
        try {
            const qrImageUrl = await QRCode.toDataURL(latestQR);
            return res.send(`
                <div style="text-align: center; font-family: sans-serif; margin-top: 30px;">
                    <h2 style="color: #075e54;">📲 امسح الباركود لربط واتساب أبو حريرة</h2>
                    <p>افتح الواتساب ⬅️ الأجهزة المرتبطة ⬅️ ربط جهاز</p>
                    <img src="${qrImageUrl}" style="width: 280px; height: 280px; border: 3px solid #075e54; padding: 10px; border-radius: 12px; background: white;" />
                    <p style="color: gray; margin-top: 15px;">تتحدث الصفحة تلقائياً كل 5 ثوانٍ...</p>
                    <script>
                        setTimeout(() => { location.reload(); }, 5000);
                    </script>
                </div>
            `);
        } catch (err) {
            return res.send("حدث خطأ أثناء إنشاء صورة الباركود.");
        }
    }

    return res.send(`
        <div style="text-align: center; font-family: sans-serif; margin-top: 50px;">
            <h2>⏳ جاري تجهيز الباركود...</h2>
            <p>يرجى الانتظار ثوانٍ معدودة وسنعرض الباركود تلقائياً.</p>
            <script>
                setTimeout(() => { location.reload(); }, 3000);
            </script>
        </div>
    `);
});

app.listen(PORT, () => {
    console.log(`🚀 السيرفر يعمل على البورت: ${PORT}`);
});

// 2. إعدادات شيت قوقل
const SHEET_ID = "14JF5utSJlgNbna31axEkC9fqZsCJMAMW1kU_JVgFSmg";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;

const userSessions = {};

function parseArabicInt(strVal) {
    if (!strVal) return null;
    const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
    const englishDigits = "0123456789";
    let str = strVal.toString();
    for (let i = 0; i < 10; i++) {
        str = str.replace(new RegExp(arabicDigits[i], 'g'), englishDigits[i]);
    }
    const clean = str.replace(/[^\d]/g, '').trim();
    const num = parseInt(clean, 10);
    return isNaN(num) ? null : num;
}

function cleanPrice(priceVal) {
    if (!priceVal) return 0.0;
    try {
        let str = priceVal.toString();
        const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
        const englishDigits = "0123456789";
        for (let i = 0; i < 10; i++) {
            str = str.replace(new RegExp(arabicDigits[i], 'g'), englishDigits[i]);
        }
        str = str.replace(/[^\d.]/g, '');
        return parseFloat(str) || 0.0;
    } catch {
        return 0.0;
    }
}

function getDozens(nameText) {
    if (!nameText) return 2;
    const match = nameText.toString().match(/(\d+)\s*دسته/);
    return match ? parseInt(match[1], 10) : 2;
}

function parseCSV(csvText) {
    const lines = csvText.split(/\r?\n/).filter(line => line.trim() !== '');
    if (lines.length < 2) return [];
    
    const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
    
    return lines.slice(1).map(line => {
        const values = line.split(',').map(v => v.replace(/^"|"$/g, '').trim());
        const row = {};
        headers.forEach((h, idx) => {
            row[h] = values[idx] || '';
        });
        return row;
    });
}

async function loadProducts() {
    try {
        const response = await axios.get(SHEET_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        return parseCSV(response.data);
    } catch (err) {
        console.error("❌ خطأ في جلب بيانات قوقل شيت:", err.message);
        return [];
    }
}

// 3. تشغيل الواتساب عبر Baileys
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            latestQR = qr;
            isConnected = false;
        }
        
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            isConnected = true;
            latestQR = null;
            console.log('✅ تم الاتصال بالواتساب بنجاح!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            
            const senderJid = msg.key.remoteJid;
            if (senderJid.endsWith('@g.us')) continue; // منع الرد في الجروبات

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            if (!text) continue;

            await handleUserMessage(senderJid, text.trim());
        }
    });
}

// نص مساعد لعرض خيارات الاستمرار أو الإنهاء بـ "لا"
function getContinueShoppingText(session) {
    const catName = session.currentCategoryName;
    return `👇 *هل تريد صنف آخر من [${catName}]؟* اكتب رقمه.\n\n` +
           `🔄 *لاختيار قسم آخر:* اضغط *(0)* للرجوع للرئيسية.\n\n` +
           `✅ *لإنهاء الطلب وإصدار الفاتورة:* اكتب *(لا)*.`;
}

// دالة لإصدار الفاتورة المبدئية المجمعة بالصور
async function sendBulkInvoice(sender, session) {
    const cart = session.cart || [];
    if (cart.length === 0) {
        await sock.sendMessage(sender, { text: "السلة فارغة! اضغط 0 لاختيار الأصناف." });
        return;
    }

    session.step = "CONFIRM_INVOICE";
    let totalAll = 0;
    
    await sock.sendMessage(sender, { text: "🧾 *جاري إصدار الفاتورة المبدئية المجمعة... يرجى الانتظار ثوانٍ* ⏳" });
    await delay(1000);

    // حلقة تكرارية لإرسال صورة كل صنف في الفاتورة مع بياناته
    for (let i = 0; i < cart.length; i++) {
        const entry = cart[i];
        const item = entry.item;
        const qty = entry.qty;
        const imageUrl = item.image;
        
        const priceDozen = cleanPrice(item.priceDozen || item.سعر_الدستة || 0);
        const dozensPerCarton = getDozens(item.name || item.اسم_الصنف || "");
        const cartonPrice = priceDozen * dozensPerCarton;
        const itemTotal = cartonPrice * qty;
        totalAll += itemTotal;

        const captionText = `🎯 *صنف فاتورة #${i + 1}*\n` +
                           `*الكود:* ${item.code}\n` +
                           `*الصنف:* ${item.اسم_الصنف || 'حذاء لوفو'}\n` +
                           `*الكمية المطلوبة:* (${qty}) كرتونة\n` +
                           `*سعر الكرتونة:* ${cartonPrice.toLocaleString('en-US')} ج.س\n` +
                           `💰 *الإجمالي لهذا الصنف:* *${itemTotal.toLocaleString('en-US')} ج.س*`;

        if (imageUrl && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
            await sock.sendMessage(sender, { image: { url: imageUrl }, caption: captionText });
            await delay(1200); // تأخير لضمان الترتيب
        } else {
            await sock.sendMessage(sender, { text: captionText });
        }
    }

    // رسالة الإجمالي النهائي وطلب التأكيد
    const finalMsg = `----------------------------------------\n` +
                     `💰 *💰 إجمالي الفاتورة النهائي:* *${totalAll.toLocaleString('en-US')} جنيه سوداني*\n` +
                     `========================================\n\n` +
                     `*للتاكيد النهائي وإرسال بيانات التحويل اضغط (1)*\n*للإلغاء اضغط (2)*`;
    
    await sock.sendMessage(sender, { text: finalMsg });
}

// 4. دالة المحادثة التفاعلية بتدفق كلمة "لا"
async function handleUserMessage(sender, textMsg) {
    const num = parseArabicInt(textMsg);
    const lowerMsg = textMsg.toLowerCase().trim();
    const isNo = lowerMsg === 'لا' || lowerMsg === 'لاء' || lowerMsg === 'no';
    
    let session = userSessions[sender] || { step: "WELCOME", cart: [], filtered: [] };
    let currentStep = session.step || "WELCOME";

    const products = await loadProducts();
    const categoriesMap = { 1: "رجالي", 2: "نسائي", 3: "صبياني", 4: "اطفالي" };

    // 🟢 القائمة الرئيسية
    if (textMsg === "0" || currentStep === "WELCOME") {
        session = { step: "SELECT_CATEGORY", cart: session.cart || [], filtered: [] };
        const replyText = "مرحب بكم في شركة أبوحريرة الوكيل الحصري بالسودان لأحذية لوفو 👟\n📍 فروعنا: مدني وسوق ليبيا.\n\n⚠️ البيع بالكرتونة فقط.\n\nاختر القسم للبدء:\n1. رجالي\n2. نسائي\n3. صبياني\n4. اطفالي";
        await sock.sendMessage(sender, { text: replyText });
    }
    // 🟢 اختيار القسم واستعراض الأصناف
    else if (currentStep === "SELECT_CATEGORY") {
        if (num && num >= 1 && num <= 4) {
            session.currentCategoryId = num;
            session.currentCategoryName = categoriesMap[num];
            const catName = session.currentCategoryName;
            
            const filtered = products.filter(p => (p.category || "").includes(catName));
            session.filtered = filtered;

            if (filtered.length === 0) {
                await sock.sendMessage(sender, { text: `عذراً، لا توجد أصناف متوفرة حالياً في قسم (${catName}).\n\nاضغط 0 للرجوع للقائمة أو اختر قسماً آخر.` });
            } else {
                session.step = "SELECT_ITEM";
                await sock.sendMessage(sender, { text: `📦 *اصناف ${catName} - ${filtered.length} صنف*\nجاري عرض الصور...` });

                for (let i = 0; i < filtered.length; i++) {
                    const item = filtered[i];
                    const code = item.code || "بدون كود";
                    const imageUrl = item.image || "";

                    const priceDozen = cleanPrice(item.priceDozen || item.سعر_الدستة || 0);
                    const dozensPerCarton = getDozens(item.name || item.اسم_الصنف || "");
                    const cartonPrice = priceDozen * dozensPerCarton;

                    const captionText = `✅ *كرتونة أحذية لوفو ${dozensPerCarton} دستة*\n` +
                                       `${item.اسم_الصنف || 'حذاء لوفو'}\n` +
                                       `*الكود:* ${code}\n` +
                                       `*الكرتونة:* ${dozensPerCarton} دستة (${dozensPerCarton * 12} حبة)\n` +
                                       `*سعر الكرتونة:* ${cartonPrice.toLocaleString('en-US')} جنيه\n\n` +
                                       `👉 *لاختيار هذا الصنف اكتب رقم: (${i + 1})*`;

                    if (imageUrl && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
                        await sock.sendMessage(sender, { image: { url: imageUrl }, caption: captionText });
                        await delay(1200); 
                    } else {
                        await sock.sendMessage(sender, { text: captionText });
                    }
                }
                await sock.sendMessage(sender, { text: `👆 أكتب رقم الصنف للطلب (من 1 إلى ${filtered.length})\nأو اضغط 0 للرجوع للقائمة الرئيسية.` });
            }
        } 
        else {
            await sock.sendMessage(sender, { text: "⚠️ خيار غير صحيح! اختر رقم القسم (1-4) أو 0 للرجوع." });
        }
    }
    // 🟢 اختيار صنف محدد
    else if (currentStep === "SELECT_ITEM") {
        const filtered = session.filtered || [];
        
        if (num && num >= 1 && num <= filtered.length) {
            session.currentItem = filtered[num - 1];
            session.step = "ENTER_QTY";
            const itemCode = session.currentItem.code || "";
            await sock.sendMessage(sender, { text: `🎯 *اخترت الصنف كود [${itemCode}]*\n\nداير منه كم كرتونة؟ (أدخل الرقم فقط):` });
        } 
        else if (textMsg === "0") {
            session = { step: "SELECT_CATEGORY", cart: session.cart || [], filtered: [] };
            await sock.sendMessage(sender, { text: "اختر القسم:\n1. رجالي\n2. نسائي\n3. صبياني\n4. اطفالي" });
        }
        else {
            await sock.sendMessage(sender, { text: `⚠️ رقم صنف غير صحيح! اختر رقم بين (1 و ${filtered.length}) أو اضغط 0 للرجوع.` });
        }
    }
    // 🟢 تحديد الكمية
    else if (currentStep === "ENTER_QTY") {
        if (num && num > 0) {
            session.cart.push({ item: session.currentItem, qty: num });
            // الانتقال لخطوة استمرار التسوق
            session.step = "CONTINUE_SHOPPING"; 
            
            await sock.sendMessage(sender, { text: `✅ تمت إضافة (${num}) كرتونة من الكود [${session.currentItem.code}] بنجاح.` });
            await delay(500);
            
            // إرسال رسالة الخيارات الجديدة (البقاء، الانتقال، أو "لا")
            const nextStepText = getContinueShoppingText(session);
            await sock.sendMessage(sender, { text: nextStepText });
        } else {
            await sock.sendMessage(sender, { text: "⚠️ أدخل عدد كراتين صحيح (مثال: 1 أو 2)." });
        }
    }
    // 🟢 خطوة استمرار التسوق (التعامل مع كلمة "لا")
    else if (currentStep === "CONTINUE_SHOPPING") {
        const filtered = session.filtered || [];
        
        // 1. هل اختار صنفاً آخر من نفس القسم؟
        if (num && num >= 1 && num <= filtered.length) {
            session.currentItem = filtered[num - 1];
            session.step = "ENTER_QTY";
            await sock.sendMessage(sender, { text: `🎯 *اخترت الصنف كود [${session.currentItem.code}]*\n\nداير منه كم كرتونة؟ (أدخل الرقم فقط):` });
        }
        // 2. هل اختار الرجوع للرئيسية؟
        else if (textMsg === "0") {
            session = { step: "SELECT_CATEGORY", cart: session.cart || [], filtered: [] };
            await sock.sendMessage(sender, { text: "اختر القسم:\n1. رجالي\n2. نسائي\n3. صبياني\n4. اطفالي" });
        }
        // 3. هل كتب "لا" لإنهاء الطلب؟ 🌟🌟🌟
        else if (isNo) {
            // استدعاء دالة إصدار الفاتورة المجمعة بالصور
            await sendBulkInvoice(sender, session);
        }
        else {
            const nextStepText = getContinueShoppingText(session);
            await sock.sendMessage(sender, { text: `⚠️ خيار غير صحيح.\n\n${nextStepText}` });
        }
    }
    // 🟢 خطوة التأكيد النهائي على الفاتورة المجمعة
    else if (currentStep === "CONFIRM_INVOICE") {
        if (num === 1) {
            const bankText = "✅ *تم تأكيد طلبك بنجاح!*\n\n" +
                             "يرجى تحويل المبلغ إلى حسابنا البنكي:\n" +
                             "🏦 *بنك الخرطوم:* 2392448\n" +
                             "👤 *الاسم:* الشيخ السراج المأمون\n\n" +
                             "من فضلك بعد التحويل أرسل لنا هنا:\n" +
                             "1️⃣ صورة إشعار التحويل.\n" +
                             "2️⃣ الاسم الكامل.\n" +
                             "3️⃣ المدينة واسم شركة الترحيلات المطلوبة.\n\n" +
                             "شكراً لتعاملكم مع شركة أبو حريرة! ❤️";
            await sock.sendMessage(sender, { text: bankText });
            session = { step: "WELCOME", cart: [], filtered: [] };
        } else {
            await sock.sendMessage(sender, { text: "❌ تم إلغاء الطلب. اضغط 0 للبدء من جديد في أي وقت." });
            session = { step: "WELCOME", cart: [], filtered: [] };
        }
    }
    else {
        await sock.sendMessage(sender, { text: "يرجى كتابة رقم (0) للرجوع للقائمة الرئيسية." });
        session = { step: "WELCOME", cart: [], filtered: [] };
    }

    userSessions[sender] = session;
}

startBot();
