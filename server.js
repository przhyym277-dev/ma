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

/* ---------- מלאי מנוהל (נשמר בגיליון config, key=stock, כ-JSON {id:qty}) ---------- */
let runtimeStock = {};
async function loadStockFromSheet() {
  if (!SHEETS_ENABLED) return;
  try {
    const doc = await getDoc();
    const cfg = doc.sheetsByTitle['config'];
    if (!cfg) return;
    const rows = await cfg.getRows();
    const r = rows.find(x => x.get('key') === 'stock');
    if (r) { try { runtimeStock = JSON.parse(r.get('value') || '{}') || {}; } catch (e) { runtimeStock = {}; } }
  } catch (e) { console.error('loadStock:', e.message); }
}
async function saveStockToSheet() {
  if (!SHEETS_ENABLED) return;
  const doc = await getDoc();
  const cfg = await getNamedSheet(doc, 'config', ['key', 'value']);
  const rows = await cfg.getRows();
  const r = rows.find(x => x.get('key') === 'stock');
  const val = JSON.stringify(runtimeStock);
  if (r) { r.set('value', val); await r.save(); }
  else await cfg.addRow({ key: 'stock', value: val });
}
const withStock = p => ({ ...p, stock: (p.id in runtimeStock) ? runtimeStock[p.id] : null });

/* ---------- מוצרים משלימים (נשמר בגיליון config, key=related, JSON {id:[ids]}) ---------- */
let runtimeRelated = {};
async function loadRelatedFromSheet() {
  if (!SHEETS_ENABLED) return;
  try {
    const doc = await getDoc();
    const cfg = doc.sheetsByTitle['config'];
    if (!cfg) return;
    const rows = await cfg.getRows();
    const r = rows.find(x => x.get('key') === 'related');
    if (r) { try { runtimeRelated = JSON.parse(r.get('value') || '{}') || {}; } catch (e) { runtimeRelated = {}; } }
  } catch (e) { console.error('loadRelated:', e.message); }
}
async function saveRelatedToSheet() {
  if (!SHEETS_ENABLED) return;
  const doc = await getDoc();
  const cfg = await getNamedSheet(doc, 'config', ['key', 'value']);
  const rows = await cfg.getRows();
  const r = rows.find(x => x.get('key') === 'related');
  const val = JSON.stringify(runtimeRelated);
  if (r) { r.set('value', val); await r.save(); }
  else await cfg.addRow({ key: 'related', value: val });
}
/* ---------- מחירי מבצע (config key=sale, JSON {id:price}) ---------- */
let runtimeSale = {};
async function loadSaleFromSheet() {
  if (!SHEETS_ENABLED) return;
  try {
    const doc = await getDoc();
    const cfg = doc.sheetsByTitle['config'];
    if (!cfg) return;
    const rows = await cfg.getRows();
    const r = rows.find(x => x.get('key') === 'sale');
    if (r) { try { runtimeSale = JSON.parse(r.get('value') || '{}') || {}; } catch (e) { runtimeSale = {}; } }
  } catch (e) { console.error('loadSale:', e.message); }
}
async function saveSaleToSheet() {
  if (!SHEETS_ENABLED) return;
  const doc = await getDoc();
  const cfg = await getNamedSheet(doc, 'config', ['key', 'value']);
  const rows = await cfg.getRows();
  const r = rows.find(x => x.get('key') === 'sale');
  const val = JSON.stringify(runtimeSale);
  if (r) { r.set('value', val); await r.save(); }
  else await cfg.addRow({ key: 'sale', value: val });
}

/* ---------- סרגל הודעה (config key=announcement) ---------- */
let runtimeAnnouncement = '';
async function loadAnnouncementFromSheet() {
  if (!SHEETS_ENABLED) return;
  try {
    const doc = await getDoc();
    const cfg = doc.sheetsByTitle['config'];
    if (!cfg) return;
    const rows = await cfg.getRows();
    const r = rows.find(x => x.get('key') === 'announcement');
    if (r) runtimeAnnouncement = String(r.get('value') || '');
  } catch (e) { console.error('loadAnnouncement:', e.message); }
}
async function saveAnnouncementToSheet(text) {
  runtimeAnnouncement = text;
  if (!SHEETS_ENABLED) return;
  const doc = await getDoc();
  const cfg = await getNamedSheet(doc, 'config', ['key', 'value']);
  const rows = await cfg.getRows();
  const r = rows.find(x => x.get('key') === 'announcement');
  if (r) { r.set('value', text); await r.save(); }
  else await cfg.addRow({ key: 'announcement', value: text });
}

const withExtras = p => ({ ...p, stock: (p.id in runtimeStock) ? runtimeStock[p.id] : null, related: runtimeRelated[p.id] || [], salePrice: (p.id in runtimeSale) ? runtimeSale[p.id] : null });

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
    if (!SHEETS_ENABLED) return res.json({ ok: true, products: memProducts.map(withExtras), source: 'memory', limit: runtimeLimit });
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    res.json({ ok: true, products: rows.map(rowToProduct).map(withExtras), source: 'sheets', limit: runtimeLimit });
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

const truthy = v => v === true || v === 'true' || v === 'TRUE' || v === '1' || v === 1;
app.put('/api/products/:id', requireAuth, upload.array('images', 6), async (req, res) => {
  try {
    const { name, price, desc, world, category, hidden } = req.body || {};
    // תמונות: keepImages = הקיימות שנשארות (מופרד ב-|) + העלאת חדשות
    const files = (req.files && req.files.length) ? req.files : [];
    const newUrls = [];
    for (const f of files) { const u = await uploadImage(f); if (u) newUrls.push(u); }
    const keepRaw = req.body.keepImages;
    const imgUpdate = (keepRaw !== undefined) || newUrls.length;
    const keep = keepRaw !== undefined ? String(keepRaw).split('|').map(s => s.trim()).filter(Boolean) : [];
    const finalImgs = imgUpdate ? [...keep, ...newUrls] : null;

    if (!SHEETS_ENABLED) {
      const p = memProducts.find(x => String(x.id) === String(req.params.id));
      if (!p) return res.status(404).json({ ok: false, error: 'מוצר לא נמצא' });
      if (name !== undefined) p.name = String(name).trim();
      if (price !== undefined && price !== '') p.price = Number(price);
      if (desc !== undefined) p.desc = String(desc).trim();
      if (world !== undefined) p.world = world === 'rc' ? 'rc' : 'garden';
      if (category !== undefined) p.category = String(category);
      if (hidden !== undefined) p.hidden = truthy(hidden);
      if (finalImgs !== null) { p.images = finalImgs; p.image = finalImgs[0] || ''; }
      return res.json({ ok: true, product: p });
    }
    const { sheet, row } = await findRowById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'מוצר לא נמצא' });
    if (name !== undefined) row.set('name', String(name).trim());
    if (price !== undefined && price !== '') row.set('price', Number(price));
    if (desc !== undefined) row.set('desc', String(desc).trim());
    if (world !== undefined) row.set('world', world === 'rc' ? 'rc' : 'garden');
    if (category !== undefined) row.set('category', String(category));
    if (hidden !== undefined) row.set('hidden', truthy(hidden) ? 'TRUE' : 'FALSE');
    if (finalImgs !== null) {
      const imgCol = ((sheet && sheet.headerValues) || []).find(h => h.toLowerCase() === 'imageurl') || 'imageUrl';
      row.set(imgCol, finalImgs.join(' | '));
    }
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
 *  בדיקת זמן נסיעה למשלוח חינם (OpenRouteService)
 * ============================================================ */
const ORS_KEY = (process.env.ORS_API_KEY || '').replace(/\s+/g, ''); // ניקוי רווחים/שורות חדשות מהמפתח
const SHIP_ORIGIN = [35.414178, 32.590999]; // מושב רמת צבי [lng, lat]

app.post('/api/shipping/check', async (req, res) => {
  try {
    const address = String((req.body && req.body.address) || '').trim();
    if (!address) return res.json({ ok: false, error: 'נא להזין כתובת' });
    if (!ORS_KEY) return res.json({ ok: false, error: 'בדיקת מרחק אינה זמינה כרגע — נאשר בוואטסאפ' });
    // 1) המרת כתובת לקואורדינטות — Photon (OSM, תמיכה טובה בעברית, ידידותי לענן)
    const gUrl = 'https://photon.komoot.io/api/?lang=default&limit=1&osm_tag=place&q=' + encodeURIComponent(address);
    const gJson = await (await fetch(gUrl)).json();
    const feat = gJson.features && gJson.features[0];
    if (!feat) return res.json({ ok: false, error: 'לא מצאנו את היישוב — נסו שם עיר/מושב בישראל' });
    const props = feat.properties || {};
    if (props.countrycode && props.countrycode !== 'IL') return res.json({ ok: false, error: 'נא להזין יישוב בישראל' });
    const dest = feat.geometry.coordinates; // [lng,lat]
    const label = [props.name, props.state].filter(Boolean).join(', ') || address;
    // 2) חישוב זמן נסיעה ממושב רמת צבי
    const rJson = await (await fetch('https://api.openrouteservice.org/v2/directions/driving-car', {
      method: 'POST',
      headers: { 'Authorization': ORS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: [SHIP_ORIGIN, dest] })
    })).json();
    const sum = rJson.routes && rJson.routes[0] && rJson.routes[0].summary;
    if (!sum) return res.json({ ok: false, error: 'לא הצלחנו לחשב מסלול לכתובת זו' });
    res.json({ ok: true, minutes: Math.round(sum.duration / 60), km: +(sum.distance / 1000).toFixed(1), label });
  } catch (err) {
    console.error('POST /api/shipping/check:', err.message);
    res.json({ ok: false, error: 'שגיאה בבדיקת המרחק — נאשר בוואטסאפ' });
  }
});

/* ============================================================
 *  גולשים מחוברים (online presence) — אמיתי + בסיס עדין
 * ============================================================ */
const onlineMap = new Map(); // id -> lastSeen(ms)
app.get('/api/online', (req, res) => {
  const id = String(req.query.id || '').slice(0, 40) || ('x' + Math.random());
  const now = Date.now();
  onlineMap.set(id, now);
  for (const [k, t] of onlineMap) if (now - t > 40000) onlineMap.delete(k); // ניקוי לא-פעילים (40 שנ')
  const real = onlineMap.size;
  const base = 6 + (Math.floor(now / 60000) % 8); // 6–13, משתנה בהדרגה
  res.json({ ok: true, online: base + real });
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

/* ---------- מלאי ---------- */
app.post('/api/stock', requireAuth, async (req, res) => {
  try {
    const { id, stock } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'חסר מזהה מוצר' });
    if (stock === '' || stock === null || stock === undefined) delete runtimeStock[id];
    else runtimeStock[id] = Math.max(0, parseInt(stock, 10) || 0);
    await saveStockToSheet();
    res.json({ ok: true, id, stock: (id in runtimeStock) ? runtimeStock[id] : null });
  } catch (err) { console.error('POST /api/stock:', err.message); res.status(500).json({ ok: false, error: 'עדכון מלאי נכשל' }); }
});

/* ---------- מוצרים משלימים ---------- */
app.post('/api/related', requireAuth, async (req, res) => {
  try {
    const { id, related } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'חסר מזהה מוצר' });
    const arr = Array.isArray(related) ? related.filter(Boolean).map(String).slice(0, 6) : [];
    if (arr.length) runtimeRelated[id] = arr; else delete runtimeRelated[id];
    await saveRelatedToSheet();
    res.json({ ok: true, id, related: runtimeRelated[id] || [] });
  } catch (err) { console.error('POST /api/related:', err.message); res.status(500).json({ ok: false, error: 'עדכון מוצרים משלימים נכשל' }); }
});

/* ---------- מחיר מבצע ---------- */
app.post('/api/sale', requireAuth, async (req, res) => {
  try {
    const { id, price } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'חסר מזהה מוצר' });
    if (price === '' || price === null || price === undefined) delete runtimeSale[id];
    else runtimeSale[id] = Math.max(0, Number(price) || 0);
    await saveSaleToSheet();
    res.json({ ok: true, id, salePrice: (id in runtimeSale) ? runtimeSale[id] : null });
  } catch (err) { console.error('POST /api/sale:', err.message); res.status(500).json({ ok: false, error: 'עדכון מחיר מבצע נכשל' }); }
});

/* ---------- סרגל הודעה ---------- */
app.get('/api/announcement', (req, res) => res.json({ ok: true, text: runtimeAnnouncement }));
app.post('/api/announcement', requireAuth, async (req, res) => {
  try {
    await saveAnnouncementToSheet(String((req.body || {}).text || '').slice(0, 200));
    res.json({ ok: true, text: runtimeAnnouncement });
  } catch (err) { console.error('POST /api/announcement:', err.message); res.status(500).json({ ok: false, error: 'עדכון ההודעה נכשל' }); }
});

/* ---------- start ---------- */
app.listen(PORT, async () => {
  await loadLimitFromSheet();
  await loadCategoriesFromSheet();
  await loadStockFromSheet();
  await loadRelatedFromSheet();
  await loadSaleFromSheet();
  await loadAnnouncementFromSheet();
  console.log(`🌿 צרפתי שיווק רץ על http://localhost:${PORT}`);
  console.log(`   מקור מוצרים: ${SHEETS_ENABLED ? 'Google Sheets ✅' : 'זיכרון (דמו)'}`);
  console.log(`   תמונות: ${CLOUDINARY_ENABLED ? 'Cloudinary ✅' : 'data-URL'}`);
  console.log(`   סיסמת מנהל: ${ADMIN_PASSWORD ? '✅' : '⚠️ חסרה'} · סיסמת מפתח: ${DEV_PASSWORD ? '✅' : '⚠️'} · מגבלה: ${runtimeLimit}`);
});
