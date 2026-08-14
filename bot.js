import csv
import json
import os
import re
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

SHEET_ID = "14JF5utSJlgNbna31axEkC9fqZsCJMAMW1kU_JVgFSmg"
URL = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv"

user_sessions = {}


def load_products():
  try:
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    response = urllib.request.urlopen(req, timeout=5)
    lines = [line.decode("utf-8") for line in response.readlines()]
    return list(csv.DictReader(lines))
  except Exception as e:
    return []


def parse_arabic_int(str_val):
  if not str_val:
    return None
  arabic_digits = "٠١٢٣٤٥٦٧٨٩"
  english_digits = "0123456789"
  trans = str.maketrans(arabic_digits, english_digits)
  clean = str(str_val).translate(trans).strip()
  return int(clean) if clean.isdigit() else None


def clean_price(price_val):
  if not price_val:
    return 0.0
  try:
    arabic_digits = "٠١٢٣٤٥٦٧٨٩"
    english_digits = "0123456789"
    trans = str.maketrans(arabic_digits, english_digits)
    clean_str = str(price_val).translate(trans)
    clean_str = re.sub(r"[^\d.]", "", clean_str)
    return float(clean_str) if clean_str else 0.0
  except:
    return 0.0


def get_dozens(name_text):
  if not name_text:
    return 2
  match = re.search(r"(\d+)\s*دسته", str(name_text))
  return int(match.group(1)) if match else 2


class RequestHandler(BaseHTTPRequestHandler):

  # إضافة الاستجابة لطلبات GET لفحص حالة السيرفر على Render
  def do_GET(self):
    self.send_response(200)
    self.send_header("Content-Type", "text/plain; charset=utf-8")
    self.end_headers()
    self.wfile.write(
        "✅ Server is running successfully on Render!".encode("utf-8")
    )

  def do_POST(self):
    try:
      content_length = int(self.headers.get("Content-Length", 0))
      post_data = self.rfile.read(content_length)

      try:
        data = json.loads(post_data.decode("utf-8"))
      except:
        data = {}

      sender = data.get("query", {}).get("sender", "default_user")
      msg = str(data.get("query", {}).get("message", "")).strip()

      num = parse_arabic_int(msg)

      # جلب أو إنشاء الجلسة
      session = user_sessions.get(
          sender, {"step": "WELCOME", "cart": [], "filtered": []}
      )
      current_step = session.get("step", "WELCOME")

      products = load_products()
      categories_map = {1: "رجالي", 2: "نسائي", 3: "صبياني", 4: "اطفالي"}
      reply = ""

      # 1. القائمة الرئيسية
      if msg == "0" or current_step == "WELCOME":
        session["step"] = "SELECT_CATEGORY"
        session["cart"] = []
        reply = (
            "مرحب بكم في شركة أبوحريرة الوكيل الحصري بالسودان لأحذية لوفو 👟\n⚠️"
            " تنبيه: البيع بالكرتونة فقط لا يوجد بيع بالدسته أو بالحبة.\n📍"
            " فروعنا: مدني وسوق ليبيا.\n\nاختر القسم:\n1. رجالي\n2. نسائي\n3."
            " صبياني\n4. اطفالي\n\n0. الرجوع للقائمة الرئيسية في أي وقت"
        )

      # 2. اختيار القسم
      elif current_step == "SELECT_CATEGORY":
        if num in categories_map:
          cat_name = categories_map[num]
          filtered = [
              p for p in products if cat_name in p.get("category", "")
          ]
          session["filtered"] = filtered

          if not filtered:
            reply = (
                f"عذراً، لا توجد أصناف متوفرة في قسم ({cat_name}).\n\n0."
                " للرجوع للقائمة"
            )
          else:
            session["step"] = "SELECT_ITEM"
            reply = f"--- أصناف ({cat_name}) ---\n\n"
            for idx, item in enumerate(filtered, 1):
              code = item.get("code", "بدون كود")
              img = item.get("image", "")
              reply += f"{idx}. كود: {code}\n🔗 الصورة: {img}\n\n"
            reply += "اختر رقم صنف واحد فقط من القائمة (أو 0 للرجوع):"
        else:
          reply = "⚠️ خيار غير صحيح! اختر رقم من (1 إلى 4) أو 0 للرجوع."

      # 3. اختيار الصنف
      elif current_step == "SELECT_ITEM":
        filtered = session.get("filtered", [])
        if num and 1 <= num <= len(filtered):
          session["current_item"] = filtered[num - 1]
          session["step"] = "ENTER_QTY"
          item_code = session["current_item"].get("code", "")
          reply = (
              f"داير كم كرتونة من كود [{item_code}]؟\n(أدخل الرقم فقط، مثلاً: 1"
              " أو 2)"
          )
        else:
          reply = (
              "⚠️ خطأ! أدخل رقم الصنف من القائمة الموضحة اعلاه، أو 0 للرجوع."
          )

      # 4. إدخال الكمية
      elif current_step == "ENTER_QTY":
        if num and num > 0:
          session["cart"].append(
              {"item": session.get("current_item", {}), "qty": num}
          )
          session["step"] = "ASK_MORE"
          reply = (
              "تمت إضافة الصنف للسلة ✅\n\nهل تريد صنف آخر؟\n• اكتب (0) للرجوع"
              " وتصفح صنف/قسم آخر.\n• أو اكتب (1) لإصدار الفاتورة المبدئية."
          )
        else:
          reply = "⚠️ أدخل عدد كراتين صحيح (مثال: 1 أو 2)."

      # 5. السؤال أو إصدار الفاتورة
      elif current_step == "ASK_MORE":
        if num == 0:
          session["step"] = "SELECT_CATEGORY"
          reply = "اختر القسم:\n1. رجالي\n2. نسائي\n3. صبياني\n4. اطفالي"
        elif num == 1:
          cart = session.get("cart", [])
          if not cart:
            reply = "سلتك فارغة! اكتب 0 للبدء واختيار الأصناف."
          else:
            total_all = 0
            reply = (
                "🧾 *الفاتورة المبدئية - شركة أبو"
                " حريرة*\n========================================\n"
            )
            for idx, entry in enumerate(cart, 1):
              item = entry.get("item", {})
              qty = entry.get("qty", 1)

              price_dozen = clean_price(
                  item.get("priceDozen")
                  or item.get("سعر_الدستة")
                  or item.get("price", 0)
              )
              dozens_per_carton = get_dozens(
                  item.get("name") or item.get("اسم_الصنف", "")
              )

              carton_price = price_dozen * dozens_per_carton
              item_total = carton_price * qty
              total_all += item_total

              reply += (
                  f"{idx}. كود الصنف: {item.get('code', '')}\n   الكمية: {qty}"
                  f" كرتونة | الإجمالي: {item_total:,.0f} ج.س\n   🔗"
                  f" {item.get('image', '')}\n\n"
              )

            reply += "----------------------------------------\n"
            reply += f"💰 *الجملة الإجمالية:* {total_all:,.0f} جنيه سوداني\n"
            reply += "========================================\n\n"
            reply += "اكتب (1) للتأكيد والتحويل، أو (2) للإلغاء."
            session["step"] = "CONFIRM_INVOICE"
        else:
          reply = "⚠️ اكتب (0) لاختيار صنف آخر، أو (1) لإصدار الفاتورة."

      # 6. تأكيد الطلب
      elif current_step == "CONFIRM_INVOICE":
        if msg == "1" or num == 1:
          reply = (
              "✅ تم تأكيد طلبك مبدئياً!\n\nيرجى تحويل المبلغ إلى حسابنا:\n🏦"
              " بنك الخرطوم: 2392448\n👤 الاسم: الشيخ السراج المأمون\n\nبعد"
              " التحويل يرجى إرسال:\n1. الإشعار (صورة)\n2. الاسم كامل\n3. الجهة"
              " المرحل لها واسم الترحيلات."
          )
          session = {"step": "WELCOME", "cart": [], "filtered": []}
        else:
          reply = "❌ تم إلغاء الطلب. اكتب (0) للبدء من جديد في أي وقت."
          session = {"step": "WELCOME", "cart": [], "filtered": []}

      else:
        reply = "يرجى كتابة رقم (0) للرجوع للقائمة الرئيسية."
        session = {"step": "WELCOME", "cart": [], "filtered": []}

      user_sessions[sender] = session
      response_payload = json.dumps({"replies": [{"message": reply}]})

    except Exception as general_error:
      print("حدث خطأ:", general_error)
      response_payload = json.dumps({
          "replies": [{
              "message": (
                  "✅ تم التأكيد. يرجى إرسال (0) للرجوع للقائمة الرئيسية في أي"
                  " وقت."
              )
          }]
      })

    self.send_response(200)
    self.send_header("Content-Type", "application/json")
    self.end_headers()
    self.wfile.write(response_payload.encode("utf-8"))


def run(server_class=HTTPServer, handler_class=RequestHandler):
  # قراءة البورت المخصص من متغيرات بيئة Render أو استخدام 5000 افتراضياً
  port = int(os.environ.get("PORT", 5000))
  server_address = ("0.0.0.0", port)
  httpd = server_class(server_address, handler_class)
  print(f"✅ السيرفر يعمل ويستقبل على البورت {port}...")
  httpd.serve_forever()


if __name__ == "__main__":
  run()
