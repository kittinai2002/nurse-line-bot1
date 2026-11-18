# ติดตั้งเหมียวเตือนเวร 2.5.1 บน Vercel และ Turso

บอททำงานในแชตส่วนตัวกับ LINE Official Account ผู้ใช้แต่ละคนมีตารางเวรและการตั้งค่าแยกตาม LINE user ID ใช้ Vercel รับ webhook และ Turso เก็บตารางเวร ส่วน cron-job.org เรียกบอททุกนาทีเพื่อส่งแจ้งเตือน

Turso Free ระบุพื้นที่ 5 GB อ่านได้ 500 ล้านแถวต่อเดือน และเขียนได้ 10 ล้านแถวต่อเดือน ณ วันที่ตรวจสอบ 18 พฤศจิกายน 2569 การส่งข้อความเตือนแบบ push ใช้โควตา LINE OA ตามแพ็กเกจของบัญชี [ราคา Turso](https://turso.tech/pricing) · [ราคา LINE Messaging API](https://developers.line.biz/en/docs/messaging-api/pricing/)

## 1. เตรียมบัญชีและทดสอบในเครื่อง

1. สร้างฐานข้อมูลบน [Turso](https://turso.tech/) แล้วเก็บ Database URL และ Auth Token ที่เขียนข้อมูลได้
2. เปิด Messaging API ให้ LINE OA แล้วเตรียม Channel Secret กับ Channel Access Token จาก [LINE Developers Console](https://developers.line.biz/console/)
3. ติดตั้ง Node.js 20 ขึ้นไป แล้วรันคำสั่งต่อไปนี้จากโฟลเดอร์โปรเจกต์

```sh
npm ci
npm test
```

## 2. Deploy บน Vercel

นำไฟล์โปรเจกต์ขึ้น GitHub แล้ว import repository เข้า [Vercel](https://vercel.com/) ตั้งค่าตัวแปรต่อไปนี้สำหรับ Production ก่อน deploy

| ตัวแปร | ค่าที่ใช้ |
| --- | --- |
| `LINE_CHANNEL_SECRET` | Channel Secret สำหรับตรวจลายเซ็น webhook |
| `LINE_CHANNEL_ACCESS_TOKEN` | Channel Access Token สำหรับตอบกลับและส่งแจ้งเตือน |
| `TURSO_DATABASE_URL` | URL ของ Turso เช่น `libsql://nurse-line-bot-example.turso.io` |
| `TURSO_AUTH_TOKEN` | Token ของฐานข้อมูล Turso ที่เขียนข้อมูลได้ |
| `CRON_SECRET` | ค่าสุ่มที่ใช้ร่วมกันระหว่าง Vercel กับ cron-job.org |
| `LINE_OWNER_USER_ID` (ใส่หรือเว้นได้) | ใช้เพิ่มบัญชีเจ้าของเข้ารอบ cron บอทยังรับผู้ใช้อื่นที่ทักมาแบบส่วนตัวได้ |

สำหรับการอัปเกรดจาก 2.5.0 ใช้ Turso URL เดิมเพื่อให้ตารางเวรและการตั้งค่าที่บันทึกไว้พร้อมใช้งาน โค้ดจะเตรียม schema เมื่อมี webhook ของผู้ใช้หรือ cron ครั้งแรก หาก cron เดิมส่งรหัสผ่าน query string ให้เปลี่ยนเป็น header ตามขั้นตอนที่ 4

## 3. เปิด webhook ใน LINE

1. ใน LINE Developers Console เปิดแท็บ **Messaging API** ของ Channel ที่ใช้
2. ตั้ง **Webhook URL** เป็น `https://<โดเมน-vercel>/webhook` แล้วกด **Verify**
3. เปิด **Use webhook** และ **Webhook redelivery** เพื่อให้ LINE ส่งเหตุการณ์ใหม่ได้เมื่อ webhook ตอบผิดพลาด
4. เพิ่มเพื่อน OA แล้วพิมพ์ `เมนู` ในแชตส่วนตัวเพื่อทดสอบว่าตอบกลับได้จริง หากใช้ข้อความตอบอัตโนมัติของ OA อยู่ ให้ตรวจว่าข้อความตอบทั้งสองทางไม่ซ้ำกัน

หน้า `/healthz` แสดงว่าฟังก์ชัน Vercel ตอบสนองและบอทรันเวอร์ชันใด การพิมพ์ `เมนู` ช่วยยืนยันเส้นทาง LINE และการเชื่อมฐานข้อมูลด้วย

## 4. ตั้ง cron สำหรับแจ้งเตือน

สร้างงานที่ [cron-job.org](https://cron-job.org/) โดยใช้ค่าต่อไปนี้ [คู่มือการสร้างงาน cron](https://docs.cron-job.org/creating-cron-jobs.html)

| การตั้งค่า | ค่า |
| --- | --- |
| URL | `https://<โดเมน-vercel>/tick` |
| Request method | `GET` |
| Schedule | Every 1 minute |
| Custom header | ชื่อ `Authorization` และค่า `Bearer <CRON_SECRET ของโปรเจกต์>` |
| Notifications | เปิดแจ้งเตือนเมื่องานล้มเหลว |

| HTTP status | สิ่งที่ตรวจ |
| --- | --- |
| `200` | รอบตรวจสำเร็จและไม่มีรายการส่งไม่สำเร็จในรอบนั้น |
| `401` | ตรวจค่า `Authorization` ให้ตรงกับ `CRON_SECRET` |
| `500` | ตรวจ Vercel Runtime Logs และค่าเชื่อม Turso หากตอบกลับพร้อม `users_failed` ค่านี้คือจำนวนบัญชีที่ประมวลผลไม่ครบ |
| `502` | ตรวจ `reminders_expired` และ `delivery_failures` ในผลตอบกลับ บอทลองส่งซ้ำเมื่อพบปัญหาชั่วคราวและยังอยู่ในช่วงส่ง |
| `503` | ตั้ง `CRON_SECRET` บน Vercel แล้ว deploy ใหม่ |

ระบบสร้างคิวล่วงหน้าสำหรับเวรวันนี้และพรุ่งนี้ หากมีคิวอยู่แล้วแต่ cron ขาดช่วงจนเลยเวลาส่ง รอบที่ระบบกลับมาทำงานจะบันทึกสถานะหมดเวลา

## 5. ทดลองรับแจ้งเตือนจริง

1. ในแชต OA พิมพ์ `เมนู` เลือก **ตั้งค่า** แล้วตรวจสอบและยืนยันเวลาเวร
2. ลงเวรที่จะเริ่มในอนาคต ตั้งระยะเตือนให้ถึงเวลาทดสอบ แล้วกดเปิดแจ้งเตือน
3. ตรวจประวัติรันของ cron และตรวจว่าข้อความเตือนมาถึง LINE พิมพ์ `สถานะ` เพื่อดูผลการส่งล่าสุด สถานะ LINE รับข้อความแล้วหมายถึง API รับคำขอสำเร็จ ส่วนการแจ้งเตือนบนเครื่องขึ้นกับ LINE และการตั้งค่าของเครื่องผู้ใช้ด้วย

## ติดตั้ง Rich Menu (ทางเลือก)

เตรียมภาพ PNG ขนาด 2500 × 843 พิกเซล ไม่เกิน 1 MB แบ่งเป็นสามคอลัมน์สำหรับ **เวรวันนี้**, **ตารางเวรของฉัน** และ **เพิ่มเวรในเดือนถัดไป** ตั้ง `LINE_CHANNEL_ACCESS_TOKEN` ใน environment ของเครื่องที่ใช้ แล้วรันคำสั่งนี้

```sh
npm run rich-menu -- path/to/2500x843.png
```

คำสั่งนี้จะตั้งภาพเป็น Rich Menu เริ่มต้นของ OA ให้ผู้ใช้ที่ใช้เมนูเริ่มต้น
