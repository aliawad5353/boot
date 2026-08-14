const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 5000;

let latestQR = null;
let isConnected = false;

// 1. عرض الباركود أو حالة الاتصال عند فتح رابط Render
app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <div style="text-align: center; font-family: sans-serif; margin-top: 50px;">
                <h1 style="color: #2e7d32;">✅ البوت متصل بالواتساب بنجاح!</h1>
                <p style="font-size: 18px;">سيرفر شركة أبو حريرة يعمل الآن في الخلفية ويستقبل الرسائل.</p>
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
    
    const sock = makeWASocket({
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

            // منع الرد على المجموعات
            if (senderJid.endsWith('@g.us')) continue;

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            if (!text) continue;

            const replyText = await handleUserMessage(senderJid, text.trim());
            if (replyText) {
                await sock.sendMessage(senderJid, { text: replyText });
            }
        }
    });
}

// 4. معالجة الردود للفاتورة المبدئية
async function handleUserMessage(sender, textMsg) {
    const num = parseArabicInt(textMsg);
    let session = userSessions[sender] || { step: "WELCOME", cart: [], filtered: [] };
    let currentStep = session.step || "WELCOME";

    const products = await loadProducts();
    const categoriesMap = { 1: "رجالي", 2: "نسائي", 3: "صبياني", 4: "اطفالي" };
    let reply = "";

    if (textMsg === "0" || currentStep === "WELCOME") {
        session.step = "SELECT_CATEGORY";
        session.cart = [];
        reply = "مرحب بكم في شركة أبوحريرة الوكيل الحصري بالسودان لأحذية لوفو 👟\n⚠️ تنبيه: البيع بالكرتونة فقط لا يوجد بيع بالدسته أو بالحبة.\n📍 فروعنا: مدني وسوق ليبيا.\n\nاختر القسم:\n1. رجالي\n2. نسائي\n3. صبياني\n4. اطفالي\n\n0. الرجوع للقائمة الرئيسية في أي وقت";
    }
    else if (currentStep === "SELECT_CATEGORY") {
        if (num && categoriesMap[num]) {
            const catName = categoriesMap[num];
            const filtered = products.filter(p => (p.category || "").includes(catName));
            session.filtered = filtered;

            if (filtered.length === 0) {
                reply = `عذراً، لا توجد أصناف متوفرة في قسم (${catName}).\n\n0. للرجوع للقائمة`;
            } else {
                session.step = "SELECT_ITEM";
                reply = `--- أصناف (${catName}) ---\n\n`;
                filtered.forEach((item, idx) => {
                    const code = item.code || "بدون كود";
                    const img = item.image || "";
                    reply += `${idx + 1}. كود: ${code}\n🔗 الصورة: ${img}\n\n`;
                });
                reply += "اختر رقم صنف واحد فقط من القائمة (أو 0 للرجوع):";
            }
        } else {
            reply = "⚠️ خيار غير صحيح! اختر رقم من (1 إلى 4) أو 0 للرجوع.";
        }
    }
    else if (currentStep === "SELECT_ITEM") {
        const filtered = session.filtered || [];
        if (num && num >= 1 && num <= filtered.length) {
            session.currentItem = filtered[num - 1];
            session.step = "ENTER_QTY";
            const itemCode = session.currentItem.code || "";
            reply = `داير كم كرتونة من كود [${itemCode}]؟\n(أدخل الرقم فقط، مثلاً: 1 أو 2)`;
        } else {
            reply = "⚠️ خطأ! أدخل رقم الصنف من القائمة الموضحة اعلاه، أو 0 للرجوع.";
        }
    }
    else if (currentStep === "ENTER_QTY") {
        if (num && num > 0) {
            session.cart.push({ item: session.currentItem, qty: num });
            session.step = "ASK_MORE";
            reply = "تمت إضافة الصنف للسلة ✅\n\nهل تريد صنف آخر؟\n• اكتب (0) للرجوع وتصفح صنف/قسم آخر.\n• أو اكتب (1) لإصدار الفاتورة المبدئية.";
        } else {
            reply = "⚠️ أدخل عدد كراتين صحيح (مثال: 1 أو 2).";
        }
    }
    else if (currentStep === "ASK_MORE") {
        if (num === 0) {
            session.step = "SELECT_CATEGORY";
            reply = "اختر القسم:\n1. رجالي\n2. نسائي\n3. صبياني\n4. اطفالي";
        } else if (num === 1) {
            const cart = session.cart || [];
            if (cart.length === 0) {
                reply = "سلتك فارغة! اكتب 0 للبدء واختيار الأصناف.";
            } else {
                let totalAll = 0;
                reply = "🧾 *الفاتورة المبدئية - شركة أبو حريرة*\n========================================\n";
                cart.forEach((entry, idx) => {
                    const item = entry.item || {};
                    const qty = entry.qty || 1;

                    const priceDozen = cleanPrice(item.priceDozen || item.سعر_الدستة || item.price || 0);
                    const dozensPerCarton = getDozens(item.name || item.اسم_الصنف || "");

                    const cartonPrice = priceDozen * dozensPerCarton;
                    const itemTotal = cartonPrice * qty;
                    totalAll += itemTotal;

                    reply += `${idx + 1}. كود الصنف: ${item.code || ''}\n   الكمية: ${qty} كرتونة | الإجمالي: ${itemTotal.toLocaleString('en-US')} ج.س\n   🔗 ${item.image || ''}\n\n`;
                });

                reply += "----------------------------------------\n";
                reply += `💰 *الجملة الإجمالية:* ${totalAll.toLocaleString('en-US')} جنيه سوداني\n`;
                reply += "========================================\n\n";
                reply += "اكتب (1) للتأكيد والتحويل، أو (2) للإلغاء.";
                session.step = "CONFIRM_INVOICE";
            }
        } else {
            reply = "⚠️ اكتب (0) لاختيار صنف آخر، أو (1) لإصدار الفاتورة.";
        }
    }
    else if (currentStep === "CONFIRM_INVOICE") {
        if (textMsg === "1" || num === 1) {
            reply = "✅ تم تأكيد طلبك مبدئياً!\n\nيرجى تحويل المبلغ إلى حسابنا:\n🏦 بنك الخرطوم: 2392448\n👤 الاسم: الشيخ السراج المأمون\n\nبعد التحويل يرجى إرسال:\n1. الإشعار (صورة)\n2. الاسم كامل\n3. الجهة المرحل لها واسم الترحيلات.";
            session = { step: "WELCOME", cart: [], filtered: [] };
        } else {
            reply = "❌ تم إلغاء الطلب. اكتب (0) للبدء من جديد في أي وقت.";
            session = { step: "WELCOME", cart: [], filtered: [] };
        }
    }
    else {
        reply = "يرجى كتابة رقم (0) للرجوع للقائمة الرئيسية.";
        session = { step: "WELCOME", cart: [], filtered: [] };
    }

    userSessions[sender] = session;
    return reply;
}

startBot();
