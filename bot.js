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
                <p style="font-size: 18px;">سيرفر أبو حريرة يعمل في الخلفية ويستقبل طلبات الزبائن بالصور المباشرة.</p>
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

// 4. دالة المحادثة التفاعلية بالصور المباشرة
async function handleUserMessage(sender, textMsg) {
    const num = parseArabicInt(textMsg);
    let session = userSessions[sender] || { step: "WELCOME", cart: [], filtered: [] };
    let currentStep = session.step || "WELCOME";

    const products = await loadProducts();
    const categoriesMap = { 1: "رجالي", 2: "نسائي", 3: "صبياني", 4: "اطفالي" };

    // 🟢 القائمة الرئيسية
    if (textMsg === "0" || currentStep === "WELCOME") {
        session.step = "SELECT_CATEGORY";
        const replyText = "مرحب بكم في شركة أبوحريرة الوكيل الحصري بالسودان لأحذية لوفو 👟\n⚠️ تنبيه: البيع بالكرتونة فقط لا يوجد بيع بالدسته أو بالحبة.\n📍 فروعنا: مدني وسوق ليبيا.\n\nاختر القسم:\n1. رجالي\n2. نسائي\n3. صبياني\n4. اطفالي\n\n0. الرجوع للقائمة الرئيسية في أي وقت";
        await sock.sendMessage(sender, { text: replyText });
    }
    // 🟢 اختيار القسم واستعراض الأصناف (صورة لكل صنف + بياناته تحتها مباشرة)
    else if (currentStep === "SELECT_CATEGORY") {
        if (num && categoriesMap[num]) {
            const catName = categoriesMap[num];
            const filtered = products.filter(p => (p.category || "").includes(catName));
            session.filtered = filtered;

            if (filtered.length === 0) {
                await sock.sendMessage(sender, { text: `عذراً، لا توجد أصناف متوفرة حالياً في قسم (${catName}).\n\n0. للرجوع للقائمة` });
            } else {
                session.step = "SELECT_ITEM";
                await sock.sendMessage(sender, { text: `📦 *اصناف ${catName} - ${filtered.length} صنف*\nسأعرضها لك الآن...` });

                for (let i = 0; i < filtered.length; i++) {
                    const item = filtered[i];
                    const code = item.code || "بدون كود";
                    const imageUrl = item.image || "";

                    const priceDozen = cleanPrice(item.priceDozen || item.سعر_الدستة || 0);
                    const dozensPerCarton = getDozens(item.name || item.اسم_الصنف || "");
                    const cartonPrice = priceDozen * dozensPerCarton;

                    // النص الذي يظهر أسفل صورة الصنف تماماً
                    const captionText = `✅ *كرتونة أحذية لوفو ${dozensPerCarton} دسته*\n` +
                                       `${catName}\n` +
                                       `*الكود:* ${code}\n` +
                                       `*القسم:* ${catName}\n` +
                                       `*الكرتونة:* ${dozensPerCarton} دستة (${dozensPerCarton * 12} حبة)\n` +
                                       `*سعر الكرتونة:* ${cartonPrice.toLocaleString('en-US')} جنيه\n\n` +
                                       `👉 *لاختيار هذا الصنف اكتب رقم: (${i + 1})*`;

                    if (imageUrl && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
                        await sock.sendMessage(sender, { 
                            image: { url: imageUrl }, 
                            caption: captionText 
                        });
                        await delay(1200); // تأخير زمني طفيف لضمان ترتيب الوصول
                    } else {
                        await sock.sendMessage(sender, { text: captionText });
                    }
                }
                
                await sock.sendMessage(sender, { text: `👆 أكتب رقم الصنف للطلب (من 1 إلى ${filtered.length}) أو اضغط 0 للرجوع للقائمة.` });
            }
        } else {
            await sock.sendMessage(sender, { text: "⚠️ خيار غير صحيح! اختر رقم القسم من (1 إلى 4) أو 0 للرجوع." });
        }
    }
    // 🟢 الزبون اختار صنفاً برقم محدد
    else if (currentStep === "SELECT_ITEM") {
        const filtered = session.filtered || [];
        if (num && num >= 1 && num <= filtered.length) {
            session.currentItem = filtered[num - 1];
            session.step = "ENTER_QTY";
            
            const item = session.currentItem;
            const itemCode = item.code || "";
            const imageUrl = item.image || "";

            // إرسال صورة الصنف الذي اختاره للتأكيد وسؤاله عن الكمية
            const selectedCaption = `🎯 *اخترت الصنف كود [${itemCode}]*\n\nداير منه كم كرتونة؟ (أدخل الرقم فقط، مثلاً: 1 أو 2):`;

            if (imageUrl && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
                await sock.sendMessage(sender, { image: { url: imageUrl }, caption: selectedCaption });
            } else {
                await sock.sendMessage(sender, { text: selectedCaption });
            }
        } else {
            await sock.sendMessage(sender, { text: "⚠️ رقم صنف غير صحيح! اختر الرقم المكتوب أسفل صورة الصنف، أو 0 للرجوع." });
        }
    }
    // 🟢 تحديد الكمية وإضافة الصنف للسلة
    else if (currentStep === "ENTER_QTY") {
        if (num && num > 0) {
            session.cart.push({ item: session.currentItem, qty: num });
            session.step = "ASK_MORE";

            const msg = `تمت إضافة (${num}) كرتونة من الكود [${session.currentItem.code}] بنجاح ✅\n\n` +
                        `هل تحتاج صنف آخر؟\n` +
                        `• اضغط *(0)* للرجوع للقائمة واختيار صنف آخر.\n` +
                        `• اضغط *(1)* لإصدار الفاتورة وتأكيد الشراء.`;

            await sock.sendMessage(sender, { text: msg });
        } else {
            await sock.sendMessage(sender, { text: "⚠️ أدخل عدد كراتين صحيح (مثال: 1 أو 2)." });
        }
    }
    // 🟢 خيار إضافة صنف آخر أو الذهاب للفاتورة
    else if (currentStep === "ASK_MORE") {
        if (num === 0) {
            session.step = "SELECT_CATEGORY";
            await sock.sendMessage(sender, { 
                text: "اختر القسم لاضافة صنف جديد:\n1. رجالي\n2. نسائي\n3. صبياني\n4. اطفالي" 
            });
        } else if (num === 1) {
            const cart = session.cart || [];
            if (cart.length === 0) {
                await sock.sendMessage(sender, { text: "السلة فارغة! اضغط 0 لاختيار الأصناف." });
            } else {
                let totalAll = 0;
                let invoiceText = "🧾 *الفاتورة المبدئية - شركة أبو حريرة*\n========================================\n\n";
                
                cart.forEach((entry, idx) => {
                    const item = entry.item || {};
                    const qty = entry.qty || 1;

                    const priceDozen = cleanPrice(item.priceDozen || item.سعر_الدستة || item.price || 0);
                    const dozensPerCarton = getDozens(item.name || item.اسم_الصنف || "");

                    const cartonPrice = priceDozen * dozensPerCarton;
                    const itemTotal = cartonPrice * qty;
                    totalAll += itemTotal;

                    invoiceText += `${idx + 1}. كود: *${item.code || ''}*\n   الكمية: ${qty} كرتونة | الإجمالي: ${itemTotal.toLocaleString('en-US')} ج.س\n\n`;
                });

                invoiceText += "----------------------------------------\n";
                invoiceText += `💰 *إجمالي الفاتورة:* *${totalAll.toLocaleString('en-US')} جنيه سوداني*\n`;
                invoiceText += "========================================\n\n";
                invoiceText += "هل تريد الشراء والتأكيد؟\n• اضغط *(1)* للتحويل وتأكيد البيع.\n• اضغط *(2)* لإلغاء الطلب.";
                
                await sock.sendMessage(sender, { text: invoiceText });
                session.step = "CONFIRM_INVOICE";
            }
        } else {
            await sock.sendMessage(sender, { text: "⚠️ اضغط (0) لاختيار صنف آخر، أو (1) لتأكيد الشراء والفاتورة." });
        }
    }
    // 🟢 تأكيد الشراء وإرسال بيانات الحساب
    else if (currentStep === "CONFIRM_INVOICE") {
        if (textMsg === "1" || num === 1) {
            const confirmText = "✅ *تم تأكيد طلبك بنجاح!*\n\n" +
                                "يرجى تحويل المبلغ إلى حسابنا البنكي:\n" +
                                "🏦 *بنك الخرطوم:* 2392448\n" +
                                "👤 *الاسم:* الشيخ السراج المأمون\n\n" +
                                "من فضلك بعد التحويل أرسل لنا هنا:\n" +
                                "1️⃣ صورة إشعار التحويل.\n" +
                                "2️⃣ الاسم الكامل لصاحب الطلب.\n" +
                                "3️⃣ المدينة/المنطقة واسم شركة الترحيلات المطلوبة.\n\n" +
                                "شكراً لتستوقكم من شركة أبو حريرة! ❤️";
            
            await sock.sendMessage(sender, { text: confirmText });
            session = { step: "WELCOME", cart: [], filtered: [] };
        } else {
            await sock.sendMessage(sender, { text: "❌ تم إلغاء الطلب. اضغط (0) للبدء من جديد في أي وقت." });
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
