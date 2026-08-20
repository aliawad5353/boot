const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const QRCode = require('qrcode');
const pino = require('pino');

// ==========================================
// 🛡️ معالجة الأخطاء العامة لمنع انهيار السيرفر
// ==========================================
process.on('uncaughtException', (err) => {
    console.error('🛡️ [خطأ غير متوقع تم اعتراضه]:', err.message || err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🛡️ [الوعد المرفوض تم اعتراضه]:', reason?.message || reason);
});

const app = express();
const PORT = process.env.PORT || 5000;

let latestQR = null;
let isConnected = false;
let sock = null;

// 1. خادم Express لعرض الباركود
app.get('/', async (req, res) => {
    try {
        if (isConnected) {
            return res.send(`
                <div style="text-align: center; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin-top: 50px; background-color: #f4f6f9; padding: 20px;">
                    <h1 style="color: #2e7d32;">✅ البوت متصل بالواتساب بنجاح!</h1>
                    <p style="font-size: 18px; color: #333;">سيرفر شركة أبوحريرة يعمل بنجاح ويستقبل طلبات الجملة.</p>
                </div>
            `);
        }

        if (latestQR) {
            const qrImageUrl = await QRCode.toDataURL(latestQR);
            return res.send(`
                <div style="text-align: center; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin-top: 30px;">
                    <h2 style="color: #075e54;">📲 امسح الباركود لربط واتساب شركة أبوحريرة</h2>
                    <p style="color: #555;">افتح الواتساب ⬅️ الأجهزة المرتبطة ⬅️ ربط جهاز</p>
                    <img src="${qrImageUrl}" style="width: 280px; height: 280px; border: 4px solid #075e54; padding: 10px; border-radius: 12px; background: white; box-shadow: 0 4px 8px rgba(0,0,0,0.1);" />
                    <p style="color: gray; margin-top: 15px;">تتحدث الصفحة تلقائياً كل 5 ثوانٍ...</p>
                    <script>setTimeout(() => { location.reload(); }, 5000);</script>
                </div>
            `);
        }

        return res.send(`
            <div style="text-align: center; font-family: sans-serif; margin-top: 50px;">
                <h2>⏳ جاري تجهيز الباركود...</h2>
                <p>يرجى الانتظار ثوانٍ معدودة وسنعرض الباركود تلقائياً.</p>
                <script>setTimeout(() => { location.reload(); }, 3000);</script>
            </div>
        `);
    } catch (err) {
        return res.send("حدث خطأ أثناء تحميل الصفحة، جاري الإعادة...");
    }
});

app.listen(PORT, () => {
    console.log(`🚀 السيرفر يعمل على البورت: ${PORT}`);
});

// 2. إعدادات شيت قوقل
const SHEET_ID = "14JF5utSJlgNbna31axEkC9fqZsCJMAMW1kU_JVgFSmg";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;

const userSessions = {};
const blockedUsers = {}; // كائن لحظر المشتري لمدة ساعة (3600000 ms)

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
    try {
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
    } catch (err) {
        console.error("❌ خطأ في معالجة CSV:", err.message);
        return [];
    }
}

async function loadProducts() {
    try {
        const response = await axios.get(SHEET_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
        return parseCSV(response.data);
    } catch (err) {
        console.error("❌ خطأ في جلب بيانات قوقل شيت:", err.message);
        return [];
    }
}

// 3. تشغيل الواتساب عبر Baileys مع معالجة إعادة الاتصال
async function startBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        
        sock = makeWASocket({
            logger: pino({ level: 'silent' }),
            auth: state,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000
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
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`⚠️ تم إغلاق الاتصال (السبب: ${statusCode}). إعادة الاتصال: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    setTimeout(() => startBot(), 3000); // إعادة الاتصال بعد 3 ثوانٍ
                }
            } else if (connection === 'open') {
                isConnected = true;
                latestQR = null;
                console.log('✅ تم الاتصال بالواتساب بنجاح!');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            
            for (const msg of messages) {
                try {
                    if (!msg.message || msg.key.fromMe) continue;
                    
                    const senderJid = msg.key.remoteJid;
                    if (senderJid.endsWith('@g.us')) continue; // منع الرد في الجروبات

                    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
                    if (!text) continue;

                    await handleUserMessage(senderJid, text.trim());
                } catch (msgErr) {
                    console.error("❌ خطأ في معالجة الرسالة الفردية:", msgErr.message);
                }
            }
        });
    } catch (err) {
        console.error("❌ خطأ في تشغيل startBot:", err.message);
        setTimeout(() => startBot(), 5000);
    }
}

// نص مساعد لمتابعة التسوق
function getContinueShoppingText(session) {
    const catName = session.currentCategoryName;
    return `👇 *هل تريد صنف آخر من [قسم ${catName}]؟* اكتب رقم الصنف.\n\n` +
           `🔄 *لاختيار قسم آخر:* اضغط *(0)* للرجوع للرئيسية.\n\n` +
           `🧾 *لإنهاء الطلب وطباعة الفاتورة:* اكتب *(00)*.`;
}

// دالة إصدار الفاتورة المبدئية المجمعة بالصور
async function sendBulkInvoice(sender, session) {
    try {
        const cart = session.cart || [];
        if (cart.length === 0) {
            await sock.sendMessage(sender, { text: "⚠️ السلة فارغة! اضغط (0) لاختيار الأصناف." });
            return;
        }

        session.step = "CONFIRM_INVOICE";
        let totalAll = 0;
        
        await sock.sendMessage(sender, { text: "🧾 *جاري إصدار الفاتورة المبدئية المجمعة... يرجى الانتظار ثوانٍ* ⏳" });
        await delay(1000);

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
                await delay(1200);
            } else {
                await sock.sendMessage(sender, { text: captionText });
            }
        }

        const finalMsg = `========================================\n` +
                         `💰 *إجمالي الفاتورة النهائي:* *${totalAll.toLocaleString('en-US')} جنيه سوداني*\n` +
                         `========================================\n\n` +
                         `✅ *للتأكيد النهائي وإرسال بيانات التحويل البنكي اكتب (1)*\n` +
                         `❌ *للإلغاء اكتب (0)*`;
        
        await sock.sendMessage(sender, { text: finalMsg });
    } catch (err) {
        console.error("❌ خطأ أثناء إرسال الفاتورة:", err.message);
        await sock.sendMessage(sender, { text: "عذراً، حدث خطأ أثناء تجهيز الفاتورة. اضغط (0) للبدء مجدداً." });
    }
}

// 4. الدالة الرئيسية للرد التفاعلي وحظر العملاء عند الملغين
async function handleUserMessage(sender, textMsg) {
    try {
        // 🛑 فحص هل العميل محظور حالياً؟
        if (blockedUsers[sender]) {
            const timePassed = Date.now() - blockedUsers[sender];
            const oneHour = 60 * 60 * 1000;

            if (timePassed < oneHour) {
                const remainingMinutes = Math.ceil((oneHour - timePassed) / (60 * 1000));
                await sock.sendMessage(sender, { 
                    text: `🚫 *عذراً، حسابك مغلق مؤقتاً لمدة ساعه بسبب إلغاء الطلب.*\n\nيرجى المحاولة بعد: *${remainingMinutes} دقيقة*.` 
                });
                return;
            } else {
                delete blockedUsers[sender]; // فك الحظر تلقائياً بعد انقضاء الساعة
            }
        }

        const rawText = textMsg.trim();
        const num = parseArabicInt(rawText);
        
        let session = userSessions[sender] || { step: "WELCOME", cart: [], filtered: [] };
        let currentStep = session.step || "WELCOME";

        const products = await loadProducts();
        const categoriesMap = { 1: "رجالي", 2: "نسائي", 3: "صبياني", 4: "اطفالي" };

        // 🟢 القائمة الرئيسية ورسالة الترحيب المعدلة
        if (rawText === "0" || currentStep === "WELCOME") {
            session = { step: "SELECT_CATEGORY", cart: session.cart || [], filtered: [] };
            const welcomeText = `✨ *مرحبا بكم في شركة أبوحريرة* ✨\n` +
                                `الوكيل الحصري لأحذية *لوفو (LUFO)* بالسودان 👟👠\n\n` +
                                `⚠️ *تنبيه مهم جداً:*\n` +
                                `- البيع بالجملة فقط (لا يوجد بيع بالحبه ولا بالدستة).\n` +
                                `- الأصناف التي تظهر لك هي الأصناف المتوفرة فقط، لا تسأل عن صنف لا يظهر لك، وإذا توفر أي صنف آخر سندمجه مع الأصناف تلقائياً.\n` +
                                `- 🚫 *سيتم حظرك تلقائياً إذا اخترت أصناف وتم استخراج الفاتورة ولم تسدد.*\n\n` +
                                `📌 *اتبع الخطوات الآتية واختر القسم:* \n` +
                                `1️⃣ رجالي\n` +
                                `2️⃣ نسائي\n` +
                                `3️⃣ صبياني\n` +
                                `4️⃣ أطفالي`;
            await sock.sendMessage(sender, { text: welcomeText });
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
                    await sock.sendMessage(sender, { text: `عذراً، لا توجد أصناف متوفرة حالياً في قسم (${catName}).\n\nاضغط (0) للرجوع للقائمة الرئيسية.` });
                } else {
                    session.step = "SELECT_ITEM";
                    await sock.sendMessage(sender, { text: `📦 *أصناف قسم ${catName} - عدد (${filtered.length}) صنف*\nجاري عرض الصور والأسعار... ⏳` });

                    for (let i = 0; i < filtered.length; i++) {
                        const item = filtered[i];
                        const code = item.code || "بدون كود";
                        const imageUrl = item.image || "";

                        const priceDozen = cleanPrice(item.priceDozen || item.سعر_الدستة || 0);
                        const dozensPerCarton = getDozens(item.name || item.اسم_الصنف || "");
                        const cartonPrice = priceDozen * dozensPerCarton;

                        const captionText = `✅ *كرتونة أحذية لوفو ${dozensPerCarton} دستة*\n` +
                                           `👟 *الصنف:* ${item.اسم_الصنف || 'حذاء لوفو'}\n` +
                                           `🏷️ *الكود:* ${code}\n` +
                                           `📦 *التعبئة:* ${dozensPerCarton} دستة (${dozensPerCarton * 12} حبة)\n` +
                                           `💵 *سعر الكرتونة:* *${cartonPrice.toLocaleString('en-US')} جنيه*\n\n` +
                                           `👉 *لاختيار هذا الصنف اكتب رقم: (${i + 1})*`;

                        if (imageUrl && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
                            await sock.sendMessage(sender, { image: { url: imageUrl }, caption: captionText });
                            await delay(1200); 
                        } else {
                            await sock.sendMessage(sender, { text: captionText });
                        }
                    }
                    await sock.sendMessage(sender, { text: `👆 اكتب رقم الصنف للطلب (من 1 إلى ${filtered.length})\nأو اضغط (0) للرجوع للقائمة الرئيسية.` });
                }
            } 
            else {
                await sock.sendMessage(sender, { text: "⚠️ خيار غير صحيح! اختر رقم القسم من (1 إلى 4) أو اضغط (0) للرجوع." });
            }
        }
        // 🟢 اختيار صنف محدد
        else if (currentStep === "SELECT_ITEM") {
            const filtered = session.filtered || [];
            
            if (num && num >= 1 && num <= filtered.length) {
                session.currentItem = filtered[num - 1];
                session.step = "ENTER_QTY";
                const itemCode = session.currentItem.code || "";
                await sock.sendMessage(sender, { text: `🎯 *اخترت الصنف كود [${itemCode}]*\n\nكم كرتونة تريد من هذا الصنف؟ (أدخل الرقم فقط):` });
            } 
            else if (rawText === "0") {
                session = { step: "SELECT_CATEGORY", cart: session.cart || [], filtered: [] };
                await sock.sendMessage(sender, { text: "📌 اختر القسم:\n1️⃣ رجالي\n2️⃣ نسائي\n3️⃣ صبياني\n4️⃣ أطفالي" });
            }
            else {
                await sock.sendMessage(sender, { text: `⚠️ رقم صنف غير صحيح! اختر رقم بين (1 و ${filtered.length}) أو اضغط (0) للرجوع.` });
            }
        }
        // 🟢 تحديد الكمية
        else if (currentStep === "ENTER_QTY") {
            if (num && num > 0) {
                session.cart.push({ item: session.currentItem, qty: num });
                session.step = "CONTINUE_SHOPPING"; 
                
                await sock.sendMessage(sender, { text: `✅ تمت إضافة (${num}) كرتونة من الكود [${session.currentItem.code}] بنجاح 🛒` });
                await delay(500);
                
                const nextStepText = getContinueShoppingText(session);
                await sock.sendMessage(sender, { text: nextStepText });
            } else {
                await sock.sendMessage(sender, { text: "⚠️ أدخل عدد كراتين صحيح (مثال: 1 أو 2)." });
            }
        }
        // 🟢 خطوة استمرار التسوق أو كتابة 00 لإنهاء الطلب وطباعة الفاتورة
        else if (currentStep === "CONTINUE_SHOPPING") {
            const filtered = session.filtered || [];
            
            // 1. كتابة (00) أو (٠٠) لطباعة الفاتورة 🌟
            if (rawText === "00" || rawText === "٠٠") {
                await sendBulkInvoice(sender, session);
            }
            // 2. الرجوع للرئيسية اختيار قسم آخر
            else if (rawText === "0" || rawText === "٠") {
                session = { step: "SELECT_CATEGORY", cart: session.cart || [], filtered: [] };
                await sock.sendMessage(sender, { text: "📌 اختر القسم:\n1️⃣ رجالي\n2️⃣ نسائي\n3️⃣ صبياني\n4️⃣ أطفالي" });
            }
            // 3. أرسل رقم الصنف للتسوق مجدداً
            else if (num && num >= 1 && num <= filtered.length) {
                session.currentItem = filtered[num - 1];
                session.step = "ENTER_QTY";
                await sock.sendMessage(sender, { text: `🎯 *اخترت الصنف كود [${session.currentItem.code}]*\n\nكم كرتونة تريد من هذا الصنف؟ (أدخل الرقم فقط):` });
            }
            else {
                const nextStepText = getContinueShoppingText(session);
                await sock.sendMessage(sender, { text: `⚠️ خيار غير صحيح.\n\n${nextStepText}` });
            }
        }
        // 🟢 خطوة التأكيد النهائي أو الإلغاء (الحظر)
        else if (currentStep === "CONFIRM_INVOICE") {
            if (rawText === "1" || rawText === "١") {
                const bankText = "✅ *تم تأكيد طلبك بنجاح!*\n\n" +
                                 "يرجى تحويل المبلغ إلى حسابنا البنكي:\n" +
                                 "🏦 *بنك الخرطوم:* 2392448\n" +
                                 "👤 *الاسم:* الشيخ السراج المأمون\n\n" +
                                 "من فضلك بعد التحويل أرسل لنا فوراً هنا:\n" +
                                 "1️⃣ صورة إشعار التحويل.\n" +
                                 "2️⃣ الاسم الكامل.\n" +
                                 "3️⃣ المدينة واسم شركة الترحيلات المطلوبة.\n\n" +
                                 "شكراً لتعاملكم مع شركة أبوحريرة! ❤️";
                await sock.sendMessage(sender, { text: bankText });
                session = { step: "WELCOME", cart: [], filtered: [] };
            } 
            // الإلغاء باختيار رقم (0) -> حظر لمدة ساعة
            else if (rawText === "0" || rawText === "٠") {
                blockedUsers[sender] = Date.now(); // تسجيل وقت الحظر
                await sock.sendMessage(sender, { 
                    text: "❌ *تم إلغاء الفاتورة.*\n\n🚫 *بناءً على سياسة الشركة، تم إغلاق المحادثة معك لمدة ساعة واحدة.*" 
                });
                delete userSessions[sender];
                return;
            } else {
                await sock.sendMessage(sender, { text: "⚠️ خيار غير صحيح! اكتب (1) للتأكيد وإرسال الحساب، أو (0) للإلغاء." });
            }
        }
        else {
            await sock.sendMessage(sender, { text: "يرجى كتابة رقم (0) للرجوع للقائمة الرئيسية." });
            session = { step: "WELCOME", cart: [], filtered: [] };
        }

        userSessions[sender] = session;
    } catch (err) {
        console.error("❌ خطأ أثناء معالجة الرسالة للعميل:", err.message);
    }
}

startBot();
