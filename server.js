/**
 * המחסן הגדול — שרת Backend
 * ------------------------------------------------------------
 * GET  /api/products  → מושך את כל המוצרים מגוגל שיטס ומחזיר JSON
 * POST /api/products  → מקבל טופס + תמונה, מעלה ל-Cloudinary,
 *                       ומוסיף שורה חדשה לגוגל שיט עם קישור התמונה.
 *
 * דורש קובץ .env (ראה .env.example).
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const streamifier = require('streamifier');
const cloudinary = require('cloudinary').v2;
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- middleware ---------- */
app.use(cors());
app.use(express.json());
// מגישים את הפרונטאנד מתוך תיקיית public
app.use(express.static(path.join(__dirname, 'public')));

// קובץ התמונה נשמר בזיכרון (buffer) ולא בדיסק — נעביר אותו ישר ל-Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

/* ---------- Cloudinary ---------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// מעלה buffer של תמונה ל-Cloudinary ומחזיר את ה-secure_url
function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'mahsan-hagadol', resource_type: 'image' },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

/* ---------- Google Sheets ---------- */
// אימות מול חשבון שירות (Service Account)
// ניקוי המפתח ושחזורו לפורמט PEM תקין — עמיד לכל צורת שמירה
// (מרכאות עוטפות, \n טקסטואלי, או ירידות שורה שהפכו לרווחים ב-Render)
function cleanPrivateKey(raw) {
  let k = (raw || '').trim()
    .replace(/^["']|["']$/g, '')   // הסרת מרכאות עוטפות
    .replace(/\\n/g, '\n');         // \n טקסטואלי → ירידת שורה אמיתית

  // שחזור: חילוץ הגוף בין BEGIN/END, ניקוי כל הרווחים, ועטיפה מחדש ב-64 תווים
  const m = k.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (m) {
    const label = m[1].trim();
    const body = m[2].replace(/\s+/g, '');     // הסרת כל הרווחים/שורות מהגוף
    const wrapped = (body.match(/.{1,64}/g) || []).join('\n');
    return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
  }
  return k;
}

const serviceAccountAuth = new JWT({
  email: (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim(),
  key: cleanPrivateKey(process.env.GOOGLE_PRIVATE_KEY),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// מחזיר את הגיליון הראשון (sheet) מוכן לקריאה/כתיבה
async function getSheet() {
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
  return doc.sheetsByIndex[0];
}

// ממיר שורת גיליון לאובייקט מוצר שהפרונטאנד מכיר
function rowToProduct(row) {
  const hiddenRaw = String(row.get('hidden') ?? '').trim().toLowerCase();
  return {
    id: row.get('id') || ('row-' + row.rowNumber),
    world: (row.get('world') || 'garden').trim(),     // 'garden' | 'rc'
    category: row.get('category') || '',
    name: row.get('name') || '',
    desc: row.get('desc') || '',
    price: Number(row.get('price')) || 0,
    image: row.get('imageUrl') || row.get('imageurl') || '',  // תומך בכותרת imageUrl/imageurl
    hidden: hiddenRaw === 'true' || hiddenRaw === '1' || hiddenRaw === 'כן',
  };
}

/* ---------- מצב הפעלה: Sheets אמיתי או זיכרון (fallback) ---------- */
// אם משתני גוגל קיימים → עובדים מול Google Sheets. אחרת → מוצרי דמו בזיכרון.
const SHEETS_ENABLED = !!(
  process.env.GOOGLE_SHEET_ID &&
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
  process.env.GOOGLE_PRIVATE_KEY
);
const CLOUDINARY_ENABLED = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

// מוצרי דמו — נטענים רק כשאין Google Sheets מחובר
let memProducts = [
  { id:'g1', world:'garden', category:'אדמה',        name:'אדמת גינה פרימיום 50 ליטר', price:45,  desc:'אדמה מועשרת ומאווררת לצמיחה בריאה.', image:'', hidden:false },
  { id:'g2', world:'garden', category:'גינון',       name:'דשא סינתטי איכותי (מ״ר)',   price:89,  desc:'מראה טבעי, עמיד לשמש ולשחיקה.',      image:'', hidden:false },
  { id:'g3', world:'garden', category:'מערכת השקיה', name:'מערכת השקיה בטפטוף',        price:320, desc:'ערכה מלאה לחיסכון במים ובזמן.',      image:'', hidden:false },
  { id:'g4', world:'garden', category:'כלי מעון',     name:'עציץ טרקוטה גדול',          price:120, desc:'חרס איכותי, מתאים לפנים ולחוץ.',     image:'', hidden:false },
  { id:'g5', world:'garden', category:'דשן אורגני',   name:'דשן אורגני 5 ק״ג',          price:65,  desc:'הזנה מתמשכת לצמחים פורחים.',         image:'', hidden:false },
  { id:'g6', world:'garden', category:'כלים',        name:'מזמרה מקצועית',             price:180, desc:'להב פלדה חד, אחיזה ארגונומית.',      image:'', hidden:false },
  { id:'r1', world:'rc', category:'באגי',     name:'מכונית באגי מקצועית 4X4', price:1200, desc:'מתח מלא, מתלים מוגברים לכל שטח.',  image:'', hidden:false },
  { id:'r2', world:'rc', category:'דריפט',    name:'מכונית דריפט מהירה',      price:850,  desc:'ג׳יירו וצמיגי דריפט לשליטה מלאה.', image:'', hidden:false },
  { id:'r3', world:'rc', category:'מכוניות',  name:'רכב מירוץ מהיר 1:14',     price:290,  desc:'מהירות גבוהה ושליטה מדויקת.',      image:'', hidden:false },
  { id:'r4', world:'rc', category:'טיפוס',    name:'רכב טיפוס סלעים Crawler', price:750,  desc:'מנוע חזק לטיפוס על כל מכשול.',     image:'', hidden:false },
];

// מעלה תמונה: Cloudinary אם מוגדר, אחרת data-URL (כדי שתעבוד גם בלי Cloudinary)
async function uploadImage(file) {
  if (!file) return '';
  if (CLOUDINARY_ENABLED) {
    const result = await uploadToCloudinary(file.buffer);
    return result.secure_url;
  }
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

// מגבלת מוצרים פעילים (ניתן לשינוי דרך משתנה סביבה MAX_PRODUCTS)
const MAX_PRODUCTS = Number(process.env.MAX_PRODUCTS) || 60;

// סופר מוצרים פעילים (לא מוסתרים) — לצורך אכיפת המגבלה
async function countActiveProducts() {
  if (!SHEETS_ENABLED) return memProducts.filter(p => !p.hidden).length;
  const sheet = await getSheet();
  const rows = await sheet.getRows();
  return rows.filter(r => String(r.get('hidden') || '').trim().toLowerCase() !== 'true').length;
}

/* ---------- אימות מנהל ---------- */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// Middleware: דורש סיסמת מנהל ב-Authorization: Bearer <password>
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : ((req.body && req.body.password) || '');
  if (!ADMIN_PASSWORD || token !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'סיסמת מנהל שגויה' });
  }
  next();
}

// מאתר שורה בגיליון לפי id
async function findRowById(id) {
  const sheet = await getSheet();
  const rows = await sheet.getRows();
  const row = rows.find(r => String(r.get('id')) === String(id));
  return { sheet, row };
}

/* ============================================================
 *  POST /api/admin/login — אימות סיסמה (לפתיחת הפאנל)
 * ============================================================ */
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'סיסמה שגויה' });
  }
  res.json({ ok: true });
});

/* ============================================================
 *  GET /api/products  — רשימת מוצרים מגוגל שיטס
 * ============================================================ */
app.get('/api/products', async (req, res) => {
  try {
    if (!SHEETS_ENABLED) {
      return res.json({ ok: true, products: memProducts, source: 'memory', limit: MAX_PRODUCTS });
    }
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    res.json({ ok: true, products: rows.map(rowToProduct), source: 'sheets', limit: MAX_PRODUCTS });
  } catch (err) {
    console.error('GET /api/products failed:', err.message);
    res.status(500).json({ ok: false, error: 'נכשלה משיכת המוצרים מגוגל שיטס' });
  }
});

/* ============================================================
 *  POST /api/products  — הוספת מוצר חדש (טופס + תמונה)
 *  Content-Type: multipart/form-data
 *  שדות: name, world, price, desc, status, image(file)
 * ============================================================ */
app.post('/api/products', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const { name, world, price, desc, status } = req.body;

    // ולידציה בסיסית
    if (!name || !String(name).trim() || !price) {
      return res.status(400).json({ ok: false, error: 'חסר שם מוצר או מחיר' });
    }

    // אכיפת מגבלת מוצרים פעילים
    const activeCount = await countActiveProducts();
    if (activeCount >= MAX_PRODUCTS) {
      return res.status(409).json({
        ok: false, limitReached: true,
        error: `הגעת למגבלה של ${MAX_PRODUCTS} מוצרים פעילים. כדי להוסיף מוצר חדש — הסתר מוצר קיים, או שדרג את החבילה.`,
      });
    }

    // 1) העלאת התמונה (Cloudinary אם מוגדר, אחרת data-URL)
    const imageUrl = await uploadImage(req.file);

    const base = {
      id: 'p' + Date.now(),
      world: world === 'rc' ? 'rc' : 'garden',
      category: world === 'rc' ? 'RC' : 'גינון',
      name: String(name).trim(),
      price: Number(price),
      desc: (desc || '').trim() || 'מוצר חדש במחסן.',
    };
    const isHidden = status === 'hidden';

    // 2) שמירה: Google Sheets אם מחובר, אחרת זיכרון
    if (SHEETS_ENABLED) {
      const sheet = await getSheet();
      await sheet.loadHeaderRow();
      // מאתר את שם עמודת התמונה בפועל (imageUrl או imageurl)
      const imgCol = (sheet.headerValues || []).find(h => h.toLowerCase() === 'imageurl') || 'imageUrl';
      const rowObj = {
        ...base,
        hidden: isHidden ? 'TRUE' : 'FALSE',
        createdAt: new Date().toISOString(),
      };
      rowObj[imgCol] = imageUrl;
      await sheet.addRow(rowObj);
    } else {
      memProducts.unshift({ ...base, image: imageUrl, hidden: isHidden });
    }

    res.json({ ok: true, product: { ...base, image: imageUrl, hidden: isHidden }, _img: { got: !!req.file, size: req.file ? req.file.size : 0, cloud: CLOUDINARY_ENABLED } });
  } catch (err) {
    console.error('POST /api/products failed:', err.message);
    res.status(500).json({ ok: false, error: 'נכשלה שמירת המוצר' });
  }
});

/* ============================================================
 *  PUT /api/products/:id — עדכון מוצר (שם, מחיר, תיאור, עולם, הצגה/הסתרה)
 * ============================================================ */
app.put('/api/products/:id', requireAuth, async (req, res) => {
  try {
    const { name, price, desc, world, category, hidden } = req.body || {};

    if (!SHEETS_ENABLED) {
      const p = memProducts.find(x => String(x.id) === String(req.params.id));
      if (!p) return res.status(404).json({ ok: false, error: 'מוצר לא נמצא' });
      if (name !== undefined) p.name = String(name).trim();
      if (price !== undefined) p.price = Number(price);
      if (desc !== undefined) p.desc = String(desc).trim();
      if (world !== undefined) p.world = world === 'rc' ? 'rc' : 'garden';
      if (category !== undefined) p.category = String(category);
      if (hidden !== undefined) p.hidden = !!hidden;
      return res.json({ ok: true, product: p });
    }

    const { row } = await findRowById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'מוצר לא נמצא' });

    if (name !== undefined) row.set('name', String(name).trim());
    if (price !== undefined) row.set('price', Number(price));
    if (desc !== undefined) row.set('desc', String(desc).trim());
    if (world !== undefined) row.set('world', world === 'rc' ? 'rc' : 'garden');
    if (category !== undefined) row.set('category', String(category));
    if (hidden !== undefined) row.set('hidden', hidden ? 'TRUE' : 'FALSE');

    await row.save();
    res.json({ ok: true, product: rowToProduct(row) });
  } catch (err) {
    console.error('PUT /api/products failed:', err.message);
    res.status(500).json({ ok: false, error: 'נכשל עדכון המוצר' });
  }
});

/* ============================================================
 *  DELETE /api/products/:id — הסתרה רכה (hidden = TRUE), בלי מחיקה פיזית
 * ============================================================ */
app.delete('/api/products/:id', requireAuth, async (req, res) => {
  try {
    if (!SHEETS_ENABLED) {
      const p = memProducts.find(x => String(x.id) === String(req.params.id));
      if (!p) return res.status(404).json({ ok: false, error: 'מוצר לא נמצא' });
      p.hidden = true;
      return res.json({ ok: true });
    }
    const { row } = await findRowById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'מוצר לא נמצא' });
    row.set('hidden', 'TRUE');
    await row.save();
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/products failed:', err.message);
    res.status(500).json({ ok: false, error: 'נכשלה הסתרת המוצר' });
  }
});

/* ---------- start ---------- */
app.listen(PORT, () => {
  console.log(`🌿 המחסן הגדול רץ על http://localhost:${PORT}`);
  console.log(`   מקור מוצרים: ${SHEETS_ENABLED ? 'Google Sheets ✅' : 'זיכרון (דמו) — הוסף משתני GOOGLE_* כדי לחבר Sheets'}`);
  console.log(`   תמונות: ${CLOUDINARY_ENABLED ? 'Cloudinary ✅' : 'data-URL (הוסף CLOUDINARY_* לאחסון אמיתי)'}`);
  console.log(`   סיסמת מנהל: ${ADMIN_PASSWORD ? 'מוגדרת ✅' : 'חסרה ⚠️ (הגדר ADMIN_PASSWORD)'}`);
});
