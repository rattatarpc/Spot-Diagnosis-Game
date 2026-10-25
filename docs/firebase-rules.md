# Firebase Realtime Database Rules — Self-Paced Offline Mode

ไฟล์ `database.rules.json` ที่ root ของโปรเจกต์กำหนดกฎความปลอดภัยสำหรับโหมดควิซออฟไลน์ (`assignments/{assignCode}`)

## สิ่งที่ Rules บังคับใช้

1. **ห้ามแก้ไขข้อสอบ (`quiz` snapshot) หลังเปิดรอบแล้ว**:
   - `assignments/$assignCode/quiz` เขียนได้เฉพาะตอนสร้างครั้งแรก (`!data.exists()`)
2. **ห้ามผู้เล่นแก้ไขคำตอบ (`answers`) หลังจากกดส่งแล้ว (`status !== 'in_progress'`)**:
   - `assignments/$assignCode/attempts/$studentId/answers` จะอนุญาตให้เขียนได้เฉพาะเมื่อ `status` ยังเป็น `'in_progress'` เท่านั้น
   - เมื่อ `status` เปลี่ยนเป็น `'submitted'`, `'graded'`, หรือ `'released'` การเขียนทับใต้ `answers` จะถูกปฏิเสธทันที
   - หากอาจารย์กด **รีเซ็ต attempt** (ลบ node `$studentId` ทิ้ง) ผู้เล่นจึงจะสามารถเริ่มทำใหม่ได้
3. **โครงสร้าง `meta` ต้องมี `title`, `reviewerPinHash`, และ `createdAt` เสมอ**

## ข้อจำกัดที่ยอมรับใน v1 (Static Client-Only Architecture)

เนื่องจากแอปเวอร์ชันนี้ไม่ใช้ Firebase Authentication และไม่มี Backend Server:
- การตรวจสอบรหัสผู้ตรวจ (`reviewerPinHash`) ทำผ่านฟังก์ชัน `AppServices.verifyPinSync` บนเบราว์เซอร์ก่อนเข้าหน้า Dashboard ครู
- เฉลยคำตอบ (`quiz`) ถูกโหลดมาที่เบราว์เซอร์เพื่อให้ตรวจคะแนนได้ทันทีตอนกดส่ง ผู้เล่นที่เปิด DevTools (F12) จึงยังสามารถอ่าน JSON ของข้อสอบได้ (แต่หน้า UI จะซ่อนเฉลยไว้จนกว่าอาจารย์จะปล่อยผล **และ** ถึงเวลาปิดรับคำตอบแล้ว)

## วิธีนำไปติดตั้งบน Firebase Console

1. เปิด [Firebase Console](https://console.firebase.google.com/) → เลือกโปรเจกต์ **`spot-diagnosis`**
2. ไปที่เมนู **Realtime Database** → แท็บ **Rules**
3. คัดลอกเนื้อหาทั้งหมดจากไฟล์ [`database.rules.json`](../../database.rules.json) ไปวางทับ แล้วกด **Publish**
4. ทดสอบใน **Rules Playground**:
   - ลองจำลอง `set` ที่ path `/assignments/TEST01/attempts/65001/answers/0` เมื่อ `/assignments/TEST01/attempts/65001/status` มีค่าเป็น `"submitted"` → ผลลัพธ์ต้องเป็น **Simulated write denied**
