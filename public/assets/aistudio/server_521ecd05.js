require('dotenv').config();
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.TOKEN_SECRET) console.warn('TOKEN_SECRET is not set: team members will be signed out on every restart.');

// Team logins come from .env: ADMIN_USERS=email:password,email2:password2
const ADMINS = {};
for (const pair of (process.env.ADMIN_USERS || 'admin@shop.local:change-me').split(',')) {
  const i = pair.indexOf(':');
  if (i > 0) ADMINS[pair.slice(0, i).trim().toLowerCase()] = pair.slice(i + 1).trim();
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

function signToken(user) {
  const body = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + 12 * 3600e3 })).toString('base64url');
  return `${body}.${hmac(body)}`;
}
function readToken(t) {
  const [body, sig] = String(t).split('.');
  if (!body || !sig) return null;
  const good = hmac(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url')); return p.exp > Date.now() ? p : null; } catch { return null; }
}

// ---------- Database (money is stored in paise, ready for Razorpay) ----------
const dbPath = process.env.DB_PATH || path.join(__dirname, 'shop.db');
// Store uploads alongside the database so Railway's /data volume persists them.
const uploadDir = process.env.UPLOAD_DIR || path.join(path.dirname(dbPath), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const allowedImageTypes = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = allowedImageTypes[file.mimetype];
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!allowedImageTypes[file.mimetype]) {
      return cb(new HttpError(400, 'Use a JPG, PNG, WebP or GIF image.'));
    }
    cb(null, true);
  },
});
// Ensure the database's parent directory exists before SQLite opens the file.
// On Railway, DB_PATH should point inside the attached persistent Volume (e.g. /data/shop.db).
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '',
  category TEXT DEFAULT 'General', price_paise INTEGER NOT NULL CHECK(price_paise >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0), image TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT DEFAULT '',
  address TEXT NOT NULL, pincode TEXT NOT NULL, total_paise INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'placed', payment_status TEXT NOT NULL DEFAULT 'unpaid',
  razorpay_order_id TEXT, razorpay_payment_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER, name TEXT NOT NULL, price_paise INTEGER NOT NULL, qty INTEGER NOT NULL);
`);
if (!db.prepare('SELECT 1 FROM products').get()) {
  const ins = db.prepare('INSERT INTO products(name,description,category,price_paise,stock) VALUES(?,?,?,?,?)');
  [['Cotton Kurta', 'Soft, breathable everyday kurta', 'Clothing', 79900, 25],
   ['Steel Water Bottle', '1 litre, keeps drinks cold for 24 hours', 'Home', 49900, 40],
   ['Wireless Earbuds', '20-hour battery, Bluetooth 5.3', 'Electronics', 129900, 15],
   ['Leather Wallet', 'Slim bifold with six card slots', 'Accessories', 59900, 30]].forEach((p) => ins.run(...p));
}

const app = express();
app.disable('x-powered-by');
app.use('/uploads', express.static(uploadDir, {
  dotfiles: 'deny',
  index: false,
  fallthrough: false,
}));
app.set('trust proxy', 1); // hosts put a proxy in front of the app
app.use(express.json({ limit: '100kb' }));

// ---------- Customer API (public) ----------
app.get('/api/products', (req, res) => {
  res.json(db.prepare('SELECT id,name,description,category,price_paise,stock,image FROM products WHERE active=1 ORDER BY id DESC').all());
});

// Storefront text shown to customers; edited from the admin's Storefront tab.
// Saved next to the database so it survives deploys when DB_PATH is on a volume.
const contentFile = path.join(path.dirname(dbPath), 'content.json');
const CONTENT_KEYS = 'brand tagline gate_title gate_text greeting guest_greeting headline intro cta1 cta2 sponsors_title sponsors shop_title how_title step1_title step1_text step2_title step2_text step3_title step3_text footer'.split(' ');
const readContent = () => { try { return JSON.parse(fs.readFileSync(contentFile, 'utf8')); } catch { return {}; } };
app.get('/api/content', (req, res) => res.json(readContent()));

app.post('/api/orders', (req, res) => {
  const c = req.body.customer || {};
  const cust = {
    name: str(c.name, 80), phone: str(c.phone, 20).replace(/\D/g, '').slice(-10),
    email: str(c.email, 120), address: str(c.address, 300), pincode: str(c.pincode, 6),
  };
  if (!cust.name || cust.phone.length !== 10 || !cust.address || !/^\d{6}$/.test(cust.pincode))
    throw new HttpError(400, 'Enter your name, 10-digit phone, address and 6-digit pincode.');

  const want = new Map(); // merge duplicate lines
  for (const it of Array.isArray(req.body.items) ? req.body.items : []) {
    const id = Number(it.id), qty = Number(it.qty);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 20) throw new HttpError(400, 'Your cart has an invalid item.');
    want.set(id, (want.get(id) || 0) + qty);
  }
  if (!want.size || want.size > 50) throw new HttpError(400, 'Your cart is empty.');

  const getP = db.prepare('SELECT id,name,price_paise FROM products WHERE id=? AND active=1');
  const takeStock = db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND stock>=?');
  const insOrder = db.prepare('INSERT INTO orders(name,phone,email,address,pincode,total_paise) VALUES(?,?,?,?,?,?)');
  const insItem = db.prepare('INSERT INTO order_items(order_id,product_id,name,price_paise,qty) VALUES(?,?,?,?,?)');

  const order = db.transaction(() => {
    let total = 0; const lines = [];
    for (const [id, qty] of want) {
      const p = getP.get(id);
      if (!p) throw new HttpError(400, 'An item in your cart is no longer available.');
      if (!takeStock.run(qty, id, qty).changes) throw new HttpError(409, `Not enough stock for "${p.name}".`);
      total += p.price_paise * qty; lines.push([p, qty]); // price always comes from the DB, never the browser
    }
    const oid = Number(insOrder.run(cust.name, cust.phone, cust.email, cust.address, cust.pincode, total).lastInsertRowid);
    for (const [p, qty] of lines) insItem.run(oid, p.id, p.name, p.price_paise, qty);
    return { id: oid, total_paise: total };
  })();

  // RAZORPAY (later): create a Razorpay order here with amount = order.total_paise,
  // save its id in orders.razorpay_order_id, and return { ...order, razorpay_order_id, key_id }.
  // Then add POST /api/payments/verify to check the signature and set payment_status='paid'.
  res.status(201).json(order);
});

// ---------- Team API (login required) ----------
const loginLimit = rateLimit({ windowMs: 15 * 60e3, max: 10, message: { error: 'Too many attempts. Try again in 15 minutes.' } });
app.post('/api/admin/login', loginLimit, (req, res) => {
  const email = str(req.body.email, 120).toLowerCase();
  const known = Object.hasOwn(ADMINS, email);
  const match = crypto.timingSafeEqual(sha(req.body.password ?? ''), sha(known ? ADMINS[email] : ''));
  if (!known || !match) throw new HttpError(401, 'Wrong email or password.');
  res.json({ token: signToken(email) });
});

app.use('/api/admin', (req, res, next) => {
  if (!readToken((req.headers.authorization || '').replace(/^Bearer /, ''))) throw new HttpError(401, 'Please sign in.');
  next();
});
app.post('/api/admin/upload', (req, res, next) => {
  imageUpload.single('image')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        return next(new HttpError(
          err.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
          err.code === 'LIMIT_FILE_SIZE'
            ? 'Image must be 5 MB or smaller.'
            : 'Please upload one image at a time.'
        ));
      }
      return next(err);
    }

    if (!req.file) {
      return next(new HttpError(400, 'Choose an image first.'));
    }

    res.status(201).json({ image: '/uploads/' + req.file.filename });
  });
});
function cleanProduct(b) {
  const name = str(b.name, 120), price = Math.round(Number(b.price) * 100), stock = Number(b.stock);
  if (!name || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0)
    throw new HttpError(400, 'Name, a price of 0 or more, and a whole-number stock are required.');
  const image = str(b.image, 500);
  return {
    name, description: str(b.description, 1000), category: str(b.category, 40) || 'General',
    price_paise: price, stock, image: /^(https?:\/\/|\/)/.test(image) ? image : '', active: b.active === false ? 0 : 1,
  };
}

app.get('/api/admin/products', (req, res) => res.json(db.prepare('SELECT * FROM products ORDER BY id DESC').all()));

app.post('/api/admin/products', (req, res) => {
  const id = db.prepare('INSERT INTO products(name,description,category,price_paise,stock,image,active) VALUES(@name,@description,@category,@price_paise,@stock,@image,@active)')
    .run(cleanProduct(req.body)).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});

app.put('/api/admin/products/:id', (req, res) => {
  const r = db.prepare('UPDATE products SET name=@name,description=@description,category=@category,price_paise=@price_paise,stock=@stock,image=@image,active=@active WHERE id=@id')
    .run({ ...cleanProduct(req.body), id: Number(req.params.id) });
  if (!r.changes) throw new HttpError(404, 'Product not found.');
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', (req, res) => {
  if (!db.prepare('DELETE FROM products WHERE id=?').run(Number(req.params.id)).changes) throw new HttpError(404, 'Product not found.');
  res.json({ ok: true });
});

app.get('/api/admin/orders', (req, res) => {
  const items = db.prepare('SELECT name,price_paise,qty FROM order_items WHERE order_id=?');
  res.json(db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all().map((o) => ({ ...o, items: items.all(o.id) })));
});

const STATUSES = ['placed', 'confirmed', 'shipped', 'delivered', 'cancelled'];
app.patch('/api/admin/orders/:id', (req, res) => {
  const status = req.body.status, id = Number(req.params.id);
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Invalid status.');
  db.transaction(() => {
    const o = db.prepare('SELECT status FROM orders WHERE id=?').get(id);
    if (!o) throw new HttpError(404, 'Order not found.');
    if (o.status === 'cancelled' && status !== 'cancelled') throw new HttpError(400, 'Cancelled orders cannot be reopened.');
    if (status === 'cancelled' && o.status !== 'cancelled') { // put stock back
      for (const i of db.prepare('SELECT product_id,qty FROM order_items WHERE order_id=?').all(id))
        db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(i.qty, i.product_id);
    }
    db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, id);
  })();
  res.json({ ok: true });
});

app.put('/api/admin/content', (req, res) => { // already behind the admin login check above
  const out = {};
  for (const k of CONTENT_KEYS) if (typeof req.body[k] === 'string') out[k] = req.body[k].trim().slice(0, 1500);
  fs.writeFileSync(contentFile, JSON.stringify(out, null, 2));
  res.json(out);
});

// ---------- Static sites + errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));
app.use(express.static(path.join(__dirname, '..', 'storefront')));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side.' : err.message });
});

app.listen(PORT, () => console.log(`Storefront: http://localhost:${PORT}\nTeam admin: http://localhost:${PORT}/admin`));
