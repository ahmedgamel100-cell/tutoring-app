# 📚 دروس أونلاين — نظام إدارة الدروس

## تشغيل محلي (على جهازك)

```bash
npm install
npm start
```

افتح المتصفح على: http://localhost:3000

---

## نشر على Railway (مجاني)

### الخطوات:

1. **أنشئ حساب على GitHub** (لو مش عندك)
   → https://github.com

2. **ارفع الكود على GitHub:**
   ```bash
   git init
   git add .
   git commit -m "first commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/tutoring-app.git
   git push -u origin main
   ```

3. **أنشئ حساب على Railway:**
   → https://railway.app
   → سجّل دخول بحساب GitHub

4. **أنشئ مشروع جديد:**
   → اضغط "New Project"
   → اختار "Deploy from GitHub repo"
   → اختار الـ repo اللي رفعته

5. **أضف Volume للبيانات (مهم!):**
   → في الـ project، اضغط على الـ service
   → اضغط "Volumes"
   → أضف Volume واربطه بـ `/app/data`
   → في Settings → Environment Variables أضف:
     ```
     DB_PATH=/app/data/tutoring.db
     ```

6. **Railway هيديك رابط تلقائياً** زي:
   `https://tutoring-app-production-xxxx.railway.app`

---

## ملاحظات

- البيانات بتتحفظ في SQLite database
- سعر الصرف بيتحفظ تاريخياً — كل شهر بيتحسب بسعره الصح
- الأرباح بتتحسب: (ريالات الطالب × سعر الصرف) - جنيهات المدرس
