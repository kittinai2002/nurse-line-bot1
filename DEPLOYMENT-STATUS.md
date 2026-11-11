# สถานะ 2.6.0 — 10 พฤศจิกายน 2026

- เตรียม Vercel Node.js 24 Functions, Neon PostgreSQL schema และตัวเรียก Cron แบบ Bearer header แล้ว
- ไม่มีเว็บไซต์ใหม่ ใช้เมนูใน LINE รุ่น 2.5 เหมือนเดิม รองรับ Windows แบบเดิมต่อ
- มีเครื่องมือเตรียม .env.vercel และนำเข้าฐาน Windows แบบ read-only ไม่เขียนทับบัญชีออนไลน์ที่มีอยู่
- ทดสอบการเก็บถาวร การ checkpoint ก่อนส่ง retry key หลังการหยุดกลางงาน ลายเซ็น raw body การแยกผู้ใช้ และ lease/revision fencing ด้วย PostgreSQL ผ่าน PGlite
- ยังไม่ได้สร้างฐาน Neon จริง ยังไม่ได้ Deploy Vercel บนบัญชีผู้ใช้ และยังไม่ได้ตั้ง cron-job.org หรือเปลี่ยน Webhook ของ OA จริง
- ต้องตั้ง Environment Variables, Run schema, Deploy, ตั้งตัวเรียกทุกนาที, ย้ายตารางเดิม และทดสอบ LINE จริงก่อนเปิดใช้
- ไฟล์ส่งมอบไม่มี credentials, ข้อมูลเวรจริงหรือฐานข้อมูลส่วนตัว

- ผลสุดท้าย: npm test ผ่าน 42/42 และ npm run check:vercel ผ่าน ไม่มีการเรียก LINE/Neon จริงในการทดสอบ
