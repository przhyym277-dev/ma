/**
 * צרפתי שיווק — שרת Backend
 * ------------------------------------------------------------
 * מוצרים:  GET/POST/PUT/DELETE /api/products
 * המלצות:  GET/POST /api/reviews (ציבורי) · DELETE /api/reviews/:id (מנהל)
 * תפקידים: מנהל (ADMIN_PASSWORD) · מפתח/על-מנהל (DEV_PASSWORD) — משנה מגבלת מוצרים
 * נתונים:  Google Sheets (+ Cloudinary לתמונות). יש fallback לזיכרון.
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
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

/* ---------- Cloudinary ---------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
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
function cleanPrivateKey(raw) {
  let k = (raw || '').trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
  const m = k.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (m) {
    const label = m[1].trim();
    const body = m[2].replace(/\s+/g, '');
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

// טוען את המסמך כולו (לגישה לכל הגיליונות)
async function getDoc() {
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
  return doc;
}
async function getSheet() { return (await getDoc()).sheetsByIndex[0]; }
// מחזיר גיליון לפי שם, יוצר אותו אם חסר
async function getNamedSheet(doc, title, headers) {
  return doc.sheetsByTitle[title] || (await doc.addSheet({ title, headerValues: headers }));
}

function rowToProduct(row) {
  const hiddenRaw = String(row.get('hidden') ?? '').trim().toLowerCase();
  const rawImg = row.get('imageUrl') || row.get('imageurl') || '';
  const images = String(rawImg).split('|').map(s => s.trim()).filter(Boolean);
  return {
    id: row.get('id') || ('row-' + row.rowNumber),
    world: (row.get('world') || 'garden').trim(),
    category: row.get('category') || '',
    name: row.get('name') || '',
    desc: row.get('desc') || '',
    price: Number(row.get('price')) || 0,
    image: images[0] || '',
    images,
    hidden: hiddenRaw === 'true' || hiddenRaw === '1' || hiddenRaw === 'כן',
  };
}

/* ---------- מצב הפעלה: Sheets אמיתי או זיכרון ---------- */
const SHEETS_ENABLED = !!(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
const CLOUDINARY_ENABLED = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

let memProducts = [
  { id:'g1', world:'garden', category:'אדמה',        name:'אדמת גינה פרימיום 50 ליטר', price:45,  desc:'אדמה מועשרת ומאווררת לצמיחה בריאה.', image:'', hidden:false },
  { id:'g2', world:'garden', category:'גינון',       name:'דשא סינתטי איכותי (מ״ר)',   price:89,  desc:'מראה טבעי, עמיד לשמש ולשחיקה.',      image:'', hidden:false },
  { id:'g3', world:'garden', category:'מערכת השקיה', name:'מערכת השקיה בטפטוף',        price:320, desc:'ערכה מלאה לחיסכון במים ובזמן.',      image:'', hidden:false },
  { id:'g4', world:'garden', category:'כלי מעון',     name:'עציץ טרקוטה גדול',          price:120, desc:'חרס איכותי, מתאים לפנים ולחוץ.',     image:'', hidden:false },
  { id:'r1', world:'rc', category:'באגי',     name:'מכונית באגי מקצועית 4X4', price:1200, desc:'מתח מלא, מתלים מוגברים לכל שטח.',  image:'', hidden:false },
  { id:'r2', world:'rc', category:'דריפט',    name:'מכונית דריפט מהירה',      price:850,  desc:'ג׳יירו וצמיגי דריפט לשליטה מלאה.', image:'', hidden:false },
];
let memReviews = [];

async function uploadImage(file) {
  if (!file) return '';
  if (CLOUDINARY_ENABLED) return (await uploadToCloudinary(file.buffer)).secure_url;
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

/* ---------- מגבלת מוצרים (דינמית, נשמרת בגיליון config) ---------- */
let runtimeLimit = Number(process.env.MAX_PRODUCTS) || 60;

async function loadLimitFromSheet() {
  if (!SHEETS_ENABLED) return;
  try {
    const doc = await getDoc();
    const cfg = doc.sheetsByTitle['config'];
    if (!cfg) return;
    const rows = await cfg.getRows();
    const r = rows.find(x => x.get('key') === 'maxProducts');
    if (r && Number(r.get('value')) > 0) runtimeLimit = Number(r.get('value'));
  } catch (e) { console.error('loadLimit:', e.message); }
}
async function saveLimitToSheet(val) {
  if (!SHEETS_ENABLED) return;
  const doc = await getDoc();
  const cfg = await getNamedSheet(doc, 'config', ['key', 'value']);
  const rows = await cfg.getRows();
  const r = rows.find(x => x.get('key') === 'maxProducts');
  if (r) { r.set('value', String(val)); await r.save(); }
  else await cfg.addRow({ key: 'maxProducts', value: String(val) });
}

/* ---------- קטגוריות מנוהלות (נשמרות בגיליון config, key=categories) ---------- */
let runtimeCategories = [];
async function loadCategoriesFromSheet() {
  if (!SHEETS_ENABLED) return;
  try {
    const doc = await getDoc();
    const cfg = doc.sheetsByTitle['config'];
    if (!cfg) return;
    const rows = await cfg.getRows();
    const r = rows.find(x => x.get('key') === 'categories');
    if (r) runtimeCategories = String(r.get('value') || '').split('|').map(s => s.trim()).filter(Boolean);
  } catch (e) { console.error('loadCategories:', e.message); }
}
async function saveCategoriesToSheet(arr) {
  runtimeCategories = arr;
  if (!SHEETS_ENABLED) return;
  const doc = await getDoc();
  const cfg = await getNamedSheet(doc, 'config', ['key', 'value']);
  const rows = await cfg.getRows();
  const r = rows.find(x => x.get('key') === 'categories');
  const val = arr.join('|');
  if (r) { r.set('value', val); await r.save(); }
  else await cfg.addRow({ key: 'categories', value: val });
}

async function countActiveProducts() {
  if (!SHEETS_ENABLED) return memProducts.filter(p => !p.hidden).length;
  const sheet = await getSheet();
  const rows = await sheet.getRows();
  return rows.filter(r => String(r.get('hidden') || '').trim().toLowerCase() !== 'true').length;
}

/* ---------- אימות + תפקידים ---------- */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DEV_PASSWORD = process.env.DEV_PASSWORD || 'Yair';   // על-מנהל (מפתח)

function roleFor(token) {
  if (DEV_PASSWORD && token === DEV_PASSWORD) return 'dev';
  if (ADMIN_PASSWORD && token === ADMIN_PASSWORD) return 'admin';
  return null;
}
function tokenFromReq(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : ((req.body && req.body.password) || '');
}
function requireAuth(req, res, next) {
  const role = roleFor(tokenFromReq(req));
  if (!role) return res.status(401).json({ ok: false, error: 'סיסמה שגויה' });
  req.role = role; next();
}
function requireDev(req, res, next) {
  const role = roleFor(tokenFromReq(req));
  if (role !== 'dev') return res.status(403).json({ ok: false, error: 'נדרשת הרשאת מפתח' });
  req.role = role; next();
}

async function findRowById(id) {
  const sheet = await getSheet();
  const rows = await sheet.getRows();
  return { sheet, row: rows.find(r => String(r.get('id')) === String(id)) };
}

/* ============================================================
 *  התחברות — מחזיר תפקיד (admin / dev)
 * ============================================================ */
app.post('/api/admin/login', (req, res) => {
  const role = roleFor((req.body || {}).password);
  if (!role) return res.status(401).json({ ok: false, error: 'סיסמה שגויה' });
  res.json({ ok: true, role });
});

/* ============================================================
 *  מוצרים
 * ============================================================ */
app.get('/api/products', async (req, res) => {
  try {
    if (!SHEETS_ENABLED) return res.json({ ok: true, products: memProducts, source: 'memory', limit: runtimeLimit });
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    res.json({ ok: true, products: rows.map(rowToProduct), source: 'sheets', limit: runtimeLimit });
  } catch (err) {
    console.error('GET /api/products:', err.message);
    res.status(500).json({ ok: false, error: 'נכשלה משיכת המוצרים מגוגל שיטס' });
  }
});

app.post('/api/products', requireAuth, upload.array('images', 6), async (req, res) => {
  try {
    const { name, world, price, desc, status, category } = req.body;
    if (!name || !String(name).trim() || !price) return res.status(400).json({ ok: false, error: 'חסר שם מוצר או מחיר' });

    const activeCount = await countActiveProducts();
    if (activeCount >= runtimeLimit) {
      return res.status(409).json({ ok: false, limitReached: true,
        error: `הגעת למגבלה של ${runtimeLimit} מוצרים פעילים. כדי להוסיף מוצר חדש — הסתר מוצר קיים, או שדרג את החבילה.` });
    }

    // העלאת כל התמונות שנבחרו (עד 6) ושמירתן מופרדות ב-|
    const files = (req.files && req.files.length) ? req.files : (req.file ? [req.file] : []);
    const urls = [];
    for (const file of files) { const u = await uploadImage(file); if (u) urls.push(u); }
    const imageUrl = urls.join(' | ');
    const base = {
      id: 'p' + Date.now(),
      world: world === 'rc' ? 'rc' : 'garden',
      category: (category && String(category).trim()) || (world === 'rc' ? 'RC' : 'גינון'),
      name: String(name).trim(),
      price: Number(price),
      desc: (desc || '').trim() || 'מוצר חדש במחסן.',
    };
    const isHidden = status === 'hidden';

    if (SHEETS_ENABLED) {
      const sheet = await getSheet();
      await sheet.loadHeaderRow();
      const imgCol = (sheet.headerValues || []).find(h => h.toLowerCase() === 'imageurl') || 'imageUrl';
      const rowObj = { ...base, hidden: isHidden ? 'TRUE' : 'FALSE', createdAt: new Date().toISOString() };
      rowObj[imgCol] = imageUrl;
      await sheet.addRow(rowObj);
    } else {
      memProducts.unshift({ ...base, image: urls[0] || '', images: urls, hidden: isHidden });
    }
    res.json({ ok: true, product: { ...base, image: urls[0] || '', images: urls, hidden: isHidden } });
  } catch (err) {
    console.error('POST /api/products:', err.message);
    res.status(500).json({ ok: false, error: 'נכשלה שמירת המוצר' });
  }
});

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
    console.error('PUT /api/products:', err.message);
    res.status(500).json({ ok: false, error: 'נכשל עדכון המוצר' });
  }
});

// ?permanent=1 → מחיקה פיזית מהגיליון. אחרת → הסתרה רכה (hidden=TRUE).
app.delete('/api/products/:id', requireAuth, async (req, res) => {
  const permanent = req.query.permanent === '1' || req.query.permanent === 'true';
  try {
    if (!SHEETS_ENABLED) {
      const idx = memProducts.findIndex(x => String(x.id) === String(req.params.id));
      if (idx === -1) return res.status(404).json({ ok: false, error: 'מוצר לא נמצא' });
      if (permanent) memProducts.splice(idx, 1);
      else memProducts[idx].hidden = true;
      return res.json({ ok: true, permanent });
    }
    const { row } = await findRowById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'מוצר לא נמצא' });
    if (permanent) {
      await row.delete();
    } else {
      row.set('hidden', 'TRUE');
      await row.save();
    }
    res.json({ ok: true, permanent });
  } catch (err) {
    console.error('DELETE /api/products:', err.message);
    res.status(500).json({ ok: false, error: permanent ? 'נכשלה מחיקת המוצר' : 'נכשלה הסתרת המוצר' });
  }
});

/* ============================================================
 *  המלצות (Reviews)
 * ============================================================ */
const REVIEW_HEADERS = ['id', 'name', 'rating', 'text', 'createdAt'];
function rowToReview(row) {
  return { id: row.get('id'), name: row.get('name') || '', rating: Number(row.get('rating')) || 5, text: row.get('text') || '', createdAt: row.get('createdAt') || '' };
}

// ציבורי — רשימת המלצות (החדשות קודם)
app.get('/api/reviews', async (req, res) => {
  try {
    if (!SHEETS_ENABLED) return res.json({ ok: true, reviews: memReviews });
    const doc = await getDoc();
    const sheet = await getNamedSheet(doc, 'reviews', REVIEW_HEADERS);
    const rows = await sheet.getRows();
    res.json({ ok: true, reviews: rows.map(rowToReview).reverse() });
  } catch (err) {
    console.error('GET /api/reviews:', err.message);
    res.status(500).json({ ok: false, error: 'נכשלה טעינת ההמלצות' });
  }
});

// ציבורי — הוספת המלצה
app.post('/api/reviews', async (req, res) => {
  try {
    let { name, rating, text } = req.body || {};
    name = String(name || '').trim().slice(0, 40);
    text = String(text || '').trim().slice(0, 600);
    rating = Math.max(1, Math.min(5, Math.round(Number(rating) || 5)));
    if (!name || !text) return res.status(400).json({ ok: false, error: 'נא למלא שם וטקסט המלצה' });
    const review = { id: 'rv' + Date.now(), name, rating, text, createdAt: new Date().toISOString() };
    if (!SHEETS_ENABLED) memReviews.unshift(review);
    else { const doc = await getDoc(); const sheet = await getNamedSheet(doc, 'reviews', REVIEW_HEADERS); await sheet.addRow(review); }
    res.json({ ok: true, review });
  } catch (err) {
    console.error('POST /api/reviews:', err.message);
    res.status(500).json({ ok: false, error: 'נכשלה שמירת ההמלצה' });
  }
});

// מנהל — מחיקת המלצה
app.delete('/api/reviews/:id', requireAuth, async (req, res) => {
  try {
    if (!SHEETS_ENABLED) { memReviews = memReviews.filter(r => r.id !== req.params.id); return res.json({ ok: true }); }
    const doc = await getDoc();
    const sheet = await getNamedSheet(doc, 'reviews', REVIEW_HEADERS);
    const rows = await sheet.getRows();
    const r = rows.find(x => String(x.get('id')) === String(req.params.id));
    if (r) await r.delete();
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/reviews:', err.message);
    res.status(500).json({ ok: false, error: 'נכשלה מחיקת ההמלצה' });
  }
});

/* ============================================================
 *  גלריה — תמונות העסק (ציבורי לצפייה, מנהל להעלאה/מחיקה)
 * ============================================================ */
const GALLERY_HEADERS = ['id', 'imageUrl', 'createdAt'];
let memGallery = [];

app.get('/api/gallery', async (req, res) => {
  try {
    if (!SHEETS_ENABLED) return res.json({ ok: true, images: memGallery });
    const doc = await getDoc();
    const sheet = await getNamedSheet(doc, 'gallery', GALLERY_HEADERS);
    const rows = await sheet.getRows();
    const images = rows.map(r => ({ id: r.get('id'), url: r.get('imageUrl') || r.get('imageurl') || '' })).filter(x => x.url);
    res.json({ ok: true, images });
  } catch (err) { console.error('GET /api/gallery:', err.message); res.json({ ok: true, images: [] }); }
});

app.post('/api/gallery', requireAuth, upload.array('images', 12), async (req, res) => {
  try {
    const files = (req.files && req.files.length) ? req.files : [];
    if (!files.length) return res.status(400).json({ ok: false, error: 'לא נבחרו תמונות' });
    const added = [];
    for (const file of files) {
      const url = await uploadImage(file);
      if (!url) continue;
      const id = 'g' + Date.now() + Math.floor(Math.random() * 1000);
      if (SHEETS_ENABLED) { const doc = await getDoc(); const sheet = await getNamedSheet(doc, 'gallery', GALLERY_HEADERS); await sheet.addRow({ id, imageUrl: url, createdAt: new Date().toISOString() }); }
      else memGallery.unshift({ id, url });
      added.push({ id, url });
    }
    res.json({ ok: true, images: added });
  } catch (err) { console.error('POST /api/gallery:', err.message); res.status(500).json({ ok: false, error: 'העלאת תמונות נכשלה' }); }
});

app.delete('/api/gallery/:id', requireAuth, async (req, res) => {
  try {
    if (!SHEETS_ENABLED) { memGallery = memGallery.filter(x => x.id !== req.params.id); return res.json({ ok: true }); }
    const doc = await getDoc();
    const sheet = await getNamedSheet(doc, 'gallery', GALLERY_HEADERS);
    const rows = await sheet.getRows();
    const r = rows.find(x => String(x.get('id')) === String(req.params.id));
    if (r) await r.delete();
    res.json({ ok: true });
  } catch (err) { console.error('DELETE /api/gallery:', err.message); res.status(500).json({ ok: false, error: 'מחיקה נכשלה' }); }
});

/* ============================================================
 *  צור קשר — פניות מהאתר (ציבורי לשליחה, מנהל לצפייה/מחיקה)
 * ============================================================ */
const CONTACT_HEADERS = ['id', 'name', 'phone', 'message', 'createdAt'];
let memContacts = [];
function rowToContact(row) {
  return { id: row.get('id'), name: row.get('name') || '', phone: row.get('phone') || '', message: row.get('message') || '', createdAt: row.get('createdAt') || '' };
}

// ציבורי — שליחת פנייה (נשמרת בלבד, מופיעה בפאנל הניהול)
app.post('/api/contact', async (req, res) => {
  try {
    let { name, phone, message } = req.body || {};
    name = String(name || '').trim().slice(0, 60);
    phone = String(phone || '').trim().slice(0, 30);
    message = String(message || '').trim().slice(0, 1000);
    if (!name || !phone) return res.status(400).json({ ok: false, error: 'נא למלא שם וטלפון' });
    const row = { id: 'ct' + Date.now(), name, phone, message, createdAt: new Date().toISOString() };
    if (!SHEETS_ENABLED) memContacts.unshift(row);
    // raw:true שומר כטקסט גולמי — מונע מגוגל שיטס למחוק את ה-0 בתחילת הטלפון
    else { const doc = await getDoc(); const sheet = await getNamedSheet(doc, 'contacts', CONTACT_HEADERS); await sheet.addRow(row, { raw: true }); }
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/contact:', err.message);
    res.status(500).json({ ok: false, error: 'נכשלה שליחת הפנייה' });
  }
});

// מנהל — רשימת פניות (החדשות קודם)
app.get('/api/contacts', requireAuth, async (req, res) => {
  try {
    if (!SHEETS_ENABLED) return res.json({ ok: true, contacts: memContacts });
    const doc = await getDoc();
    const sheet = await getNamedSheet(doc, 'contacts', CONTACT_HEADERS);
    const rows = await sheet.getRows();
    res.json({ ok: true, contacts: rows.map(rowToContact).reverse() });
  } catch (err) {
    console.error('GET /api/contacts:', err.message);
    res.status(500).json({ ok: false, error: 'נכשלה טעינת הפניות' });
  }
});

// מנהל — מחיקת פנייה
app.delete('/api/contacts/:id', requireAuth, async (req, res) => {
  try {
    if (!SHEETS_ENABLED) { memContacts = memContacts.filter(c => c.id !== req.params.id); return res.json({ ok: true }); }
    const doc = await getDoc();
    const sheet = await getNamedSheet(doc, 'contacts', CONTACT_HEADERS);
    const rows = await sheet.getRows();
    const r = rows.find(x => String(x.get('id')) === String(req.params.id));
    if (r) await r.delete();
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/contacts:', err.message);
    res.status(500).json({ ok: false, error: 'נכשלה מחיקת הפנייה' });
  }
});

/* ============================================================
 *  הגדרות — מפתח בלבד (שינוי מגבלת מוצרים)
 * ============================================================ */
app.put('/api/config', requireDev, async (req, res) => {
  try {
    const n = Number((req.body || {}).maxProducts);
    if (!Number.isFinite(n) || n < 1 || n > 5000) return res.status(400).json({ ok: false, error: 'מספר לא תקין (1–5000)' });
    runtimeLimit = Math.floor(n);
    await saveLimitToSheet(runtimeLimit);
    res.json({ ok: true, limit: runtimeLimit });
  } catch (err) {
    console.error('PUT /api/config:', err.message);
    res.status(500).json({ ok: false, error: 'נכשל עדכון ההגדרה' });
  }
});

/* ---------- קטגוריות ---------- */
app.get('/api/categories', async (req, res) => {
  res.json({ ok: true, categories: runtimeCategories });
});
app.post('/api/categories', requireAuth, async (req, res) => {
  try {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'שם קטגוריה ריק' });
    if (!runtimeCategories.includes(name)) await saveCategoriesToSheet([...runtimeCategories, name]);
    res.json({ ok: true, categories: runtimeCategories });
  } catch (err) { console.error('POST /api/categories:', err.message); res.status(500).json({ ok: false, error: 'שמירת קטגוריה נכשלה' }); }
});
app.delete('/api/categories/:name', requireAuth, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    await saveCategoriesToSheet(runtimeCategories.filter(c => c !== name));
    res.json({ ok: true, categories: runtimeCategories });
  } catch (err) { console.error('DELETE /api/categories:', err.message); res.status(500).json({ ok: false, error: 'מחיקת קטגוריה נכשלה' }); }
});

/* ---------- start ---------- */
app.listen(PORT, async () => {
  await loadLimitFromSheet();
  await loadCategoriesFromSheet();
  console.log(`🌿 צרפתי שיווק רץ על http://localhost:${PORT}`);
  console.log(`   מקור מוצרים: ${SHEETS_ENABLED ? 'Google Sheets ✅' : 'זיכרון (דמו)'}`);
  console.log(`   תמונות: ${CLOUDINARY_ENABLED ? 'Cloudinary ✅' : 'data-URL'}`);
  console.log(`   סיסמת מנהל: ${ADMIN_PASSWORD ? '✅' : '⚠️ חסרה'} · סיסמת מפתח: ${DEV_PASSWORD ? '✅' : '⚠️'} · מגבלה: ${runtimeLimit}`);
});
