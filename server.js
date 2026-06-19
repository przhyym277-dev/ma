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
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  // ב-.env המפתח נשמר בשורה אחת עם \n — נמיר אותם חזרה לירידות שורה אמיתיות
  key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
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
    image: row.get('imageUrl') || '',                  // קישור Cloudinary
    hidden: hiddenRaw === 'true' || hiddenRaw === '1' || hiddenRaw === 'כן',
  };
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
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const products = rows.map(rowToProduct);
    res.json({ ok: true, products });
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

    // 1) העלאת התמונה ל-Cloudinary (אם הועלתה)
    let imageUrl = '';
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer);
      imageUrl = result.secure_url;
    }

    // 2) בניית השורה והוספתה לגוגל שיט
    const product = {
      id: 'p' + Date.now(),
      world: world === 'rc' ? 'rc' : 'garden',
      category: world === 'rc' ? 'RC' : 'גינון',
      name: String(name).trim(),
      price: Number(price),
      desc: (desc || '').trim() || 'מוצר חדש במחסן.',
      imageUrl,
      hidden: status === 'hidden' ? 'TRUE' : 'FALSE',
      createdAt: new Date().toISOString(),
    };

    const sheet = await getSheet();
    await sheet.addRow(product);

    // מחזירים את המוצר בפורמט שהפרונטאנד מכיר
    res.json({ ok: true, product: { ...product, image: imageUrl, hidden: product.hidden === 'TRUE' } });
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
    const { row } = await findRowById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'מוצר לא נמצא' });

    const { name, price, desc, world, category, hidden } = req.body || {};
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
});
