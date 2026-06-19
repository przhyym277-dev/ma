# המחסן הגדול 🌿🏎️

קטלוג חנות (גינון + RC) עם סל קניות, שליחת הזמנה לוואטסאפ, ופאנל ניהול —
מחובר ל‑**Google Sheets** (מקור המוצרים) ו‑**Cloudinary** (אחסון תמונות).

```
mahsan-hagadol/
├── server.js          # שרת Express — GET/POST /api/products
├── package.json
├── .env.example       # תבנית למשתני סביבה
└── public/
    └── index.html     # הפרונטאנד (מחובר ל-API)
```

## 1. התקנה

```bash
cd mahsan-hagadol
npm install
```

מתקין: `express`, `cors`, `dotenv`, `multer`, `cloudinary`, `streamifier`,
`google-spreadsheet`, `google-auth-library`.

## 2. הגדרת Google Sheet

1. צרו גיליון חדש ב‑Google Sheets.
2. בשורה הראשונה הוסיפו **בדיוק** את הכותרות הבאות (כל אחת בעמודה):
   ```
   id | world | category | name | price | desc | imageUrl | hidden | createdAt
   ```
   - `world` = `garden` או `rc`
   - `hidden` = `TRUE` / `FALSE`
3. ב‑[Google Cloud Console](https://console.cloud.google.com): צרו פרויקט →
   הפעילו **Google Sheets API** → צרו **Service Account** → הורידו מפתח **JSON**.
4. שתפו את הגיליון עם כתובת המייל של ה‑Service Account (הרשאת **Editor**).

## 3. הגדרת Cloudinary

הירשמו ב‑[cloudinary.com](https://cloudinary.com) (חינמי) והעתיקו מה‑Dashboard:
`cloud_name`, `api_key`, `api_secret`.

## 4. קובץ `.env`

העתיקו את `.env.example` ל‑`.env` ומלאו את הערכים:

```bash
cp .env.example .env
```

> את `GOOGLE_PRIVATE_KEY` מעתיקים מקובץ ה‑JSON. שימו לב שכל ירידות השורה
> מיוצגות כ‑`\n` בתוך מרכאות כפולות (כמו בתבנית).

## 5. הרצה

```bash
npm start        # http://localhost:3000
# או לפיתוח עם רענון אוטומטי:
npm run dev
```

פתחו את הדפדפן בכתובת `http://localhost:3000`.

## ה‑Endpoints

| Method   | Path                  | אימות | תיאור |
|----------|-----------------------|:-----:|-------|
| `GET`    | `/api/products`       | ❌ | מחזיר `{ ok, products: [...] }` מתוך הגיליון |
| `POST`   | `/api/admin/login`    | ❌ | בודק סיסמה (`{ password }`) — מחזיר `200` / `401` |
| `POST`   | `/api/products`       | ✅ | `multipart/form-data` (שדות + קובץ `image`) → Cloudinary + שורה חדשה |
| `PUT`    | `/api/products/:id`   | ✅ | עדכון שדות (`name`, `price`, `desc`, `world`, `category`, `hidden`) |
| `DELETE` | `/api/products/:id`   | ✅ | הסתרה רכה — מעדכן `hidden=TRUE` (בלי מחיקה פיזית) |

### אימות (Authentication)

נתיבי הניהול (✅) דורשים כותרת:
```
Authorization: Bearer <ADMIN_PASSWORD>
```
בפרונטאנד: לחיצה על **"ניהול 🛠️"** פותחת חלונית סיסמה. הסיסמה נשמרת ב‑`sessionStorage`
ונשלחת בכל פנייה. שרת שמחזיר `401` מנקה את הסשן ומבקש התחברות מחדש.
הסיסמה מוגדרת ב‑`.env` תחת `ADMIN_PASSWORD`.

## עדכון מספר הוואטסאפ

ב‑`public/index.html`, שנו את הקבוע:

```js
const WA_NUMBER = '972500000000'; // ← המספר שלכם בפורמט בינלאומי, בלי + ובלי 0
```

## פריסה (Render / Railway / וכו')

- העלו את התיקייה לגיט (בלי `.env` ו‑`node_modules`).
- הגדירו את משתני הסביבה בלוח הבקרה של הספק.
- פקודת הרצה: `npm start`.
