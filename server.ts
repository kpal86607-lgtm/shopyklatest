import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');

// Team logins come from .env: ADMIN_USERS=email:password,email2:password2
const ADMINS: Record<string, string> = {};
for (const pair of (process.env.ADMIN_USERS || 'admin@shop.local:change-me').split(',')) {
  const i = pair.indexOf(':');
  if (i > 0) {
    ADMINS[pair.slice(0, i).trim().toLowerCase()] = pair.slice(i + 1).trim();
  }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

const str = (v: any, max: number): string => String(v ?? '').trim().slice(0, max);
const sha = (s: any): Buffer => crypto.createHash('sha256').update(String(s)).digest();
const hmac = (s: string): string => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

function signToken(user: string): string {
  const body = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + 12 * 3600e3 })).toString('base64url');
  return `${body}.${hmac(body)}`;
}

function readToken(t: string): { u: string; exp: number } | null {
  const [body, sig] = String(t).split('.');
  if (!body || !sig) return null;
  const good = hmac(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

// ---------- Database setup ----------
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'shop.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  long_description TEXT DEFAULT '',
  material TEXT DEFAULT '',
  care TEXT DEFAULT '',
  sizing_guide TEXT DEFAULT '',
  gallery TEXT DEFAULT '',
  category TEXT DEFAULT 'General',
  price_paise INTEGER NOT NULL CHECK(price_paise >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
  image TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT DEFAULT '',
  address TEXT NOT NULL,
  pincode TEXT NOT NULL,
  total_paise INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'placed',
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER,
  name TEXT NOT NULL,
  price_paise INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  customization TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
  title TEXT DEFAULT '',
  comment TEXT NOT NULL,
  photo_url TEXT DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// Migrations for existing tables if columns are missing
try {
  const pInfo = db.prepare("PRAGMA table_info(products)").all() as { name: string }[];
  if (!pInfo.some(c => c.name === 'long_description')) db.exec("ALTER TABLE products ADD COLUMN long_description TEXT DEFAULT ''");
  if (!pInfo.some(c => c.name === 'material')) db.exec("ALTER TABLE products ADD COLUMN material TEXT DEFAULT ''");
  if (!pInfo.some(c => c.name === 'care')) db.exec("ALTER TABLE products ADD COLUMN care TEXT DEFAULT ''");
  if (!pInfo.some(c => c.name === 'sizing_guide')) db.exec("ALTER TABLE products ADD COLUMN sizing_guide TEXT DEFAULT ''");
  if (!pInfo.some(c => c.name === 'gallery')) db.exec("ALTER TABLE products ADD COLUMN gallery TEXT DEFAULT ''");
} catch (e) {
  console.warn('Product column migration warning:', e);
}

try {
  const oiInfo = db.prepare("PRAGMA table_info(order_items)").all() as { name: string }[];
  if (!oiInfo.some((col) => col.name === 'customization')) {
    db.exec("ALTER TABLE order_items ADD COLUMN customization TEXT");
  }
} catch (e) {
  console.warn('Order items column check warning:', e);
}

// Seed initial products and reviews
const SEED_CATALOGUE = [
  {
    name: 'Cotton Kurta',
    description: 'Soft, breathable everyday kurta with subtle tailoring.',
    long_description: 'Woven on slow-speed vintage shuttle looms for a supple, tactile hand. Features mother-of-pearl button placket, hidden interior phone pocket, and hand-finished hems designed for all-day breathability and effortless drape.',
    material: '100% Long-staple Combed Muga Cotton (180 GSM). Natural dyes, hypoallergenic wash.',
    care: 'Machine wash delicate cold with like colours. Medium warm iron while slightly damp. Line dry in shade.',
    sizing_guide: 'Relaxed traditional silhouette with contemporary side slits. Chest: XS (36"), S (38"), M (40"), L (42"), XL (44"), XXL (46"). True to size.',
    category: 'Clothing',
    price_paise: 79900,
    stock: 25,
    image: '',
    reviews: [
      {
        user_name: 'Rohan M.',
        rating: 5,
        title: 'Sublime fabric and finish',
        comment: 'The fabric feels crisp yet remarkably soft. The mother-of-pearl buttons and tailored collar elevate it above ordinary kurtas. Wore it to a gallery opening and received multiple compliments.',
        photo_url: '/uploads/customer-photo-kurta-1.svg'
      },
      {
        user_name: 'Aarav K.',
        rating: 5,
        title: 'Immaculate tailoring',
        comment: 'Fits true to size with just enough ease across the chest and shoulders for comfortable movement. Beautiful subtle texture.',
        photo_url: '/uploads/customer-photo-kurta-2.svg'
      },
      {
        user_name: 'Pooja V.',
        rating: 4,
        title: 'Very comfortable everyday staple',
        comment: 'Breathable even in humid weather. Length falls right at the knee. Highly recommend.',
        photo_url: ''
      }
    ]
  },
  {
    name: 'Steel Water Bottle',
    description: '1 litre double-walled stainless flask, keeps drinks icy for 24 hours.',
    long_description: 'Engineered with TempShield double-wall vacuum insulation to keep cold beverages chilled for 24 hours or steaming hot for 12 hours. Zero condensation, food-grade silicone leakproof seal, and tough powder coat exterior.',
    material: '18/8 Pro-grade Triple-Insulated Stainless Steel with Copper Barrier Core. 100% BPA-Free.',
    care: 'Hand wash recommended with warm soapy water. Dishwasher safe lid (top rack).',
    sizing_guide: 'Volume: 1000ml (34 fl oz). Height: 28cm. Base diameter: 8.2cm. Fits standard car cup holders and backpack side sleeves.',
    category: 'Home',
    price_paise: 49900,
    stock: 40,
    image: '',
    reviews: [
      {
        user_name: 'Meera S.',
        rating: 5,
        title: 'Keeps water icy cold on long treks',
        comment: 'Hiked 6 hours under direct sun in the Western Ghats. Put ice cubes in at 6 AM and they were still clinking at 4 PM. Solid grip texture and zero leakage.',
        photo_url: '/uploads/customer-photo-bottle-1.svg'
      },
      {
        user_name: 'Karan P.',
        rating: 5,
        title: 'Aesthetic and functional',
        comment: 'Looks handsome on my workstation. Zero condensation so papers and wood desk stay completely dry.',
        photo_url: '/uploads/customer-photo-bottle-2.svg'
      }
    ]
  },
  {
    name: 'Wireless Earbuds',
    description: '20-hour battery, active noise isolation and fast pairing.',
    long_description: 'Equipped with custom-tuned 11mm biocellulose acoustic drivers and hybrid active noise cancellation (up to -38dB). Dual beamforming microphones with ENC ensure crystal clear call quality even on windy streets.',
    material: 'Matte Anodized Aluminum Charging Chassis, Recycled Polycarbonate Earbuds.',
    care: 'Wipe clean with a microfiber cloth. IPX5 water and sweat resistance.',
    sizing_guide: 'Includes 4 interchangeable ergonomic silicone tip sizes (XS, S, M, L). Lightweight 4.8g per bud.',
    category: 'Electronics',
    price_paise: 129900,
    stock: 15,
    image: '',
    reviews: [
      {
        user_name: 'Ananya R.',
        rating: 5,
        title: 'Commuting game changer',
        comment: 'Cuts through Delhi Metro screeching and engine noise effortlessly. Balanced soundstage with tight bass rather than muddy booms.',
        photo_url: '/uploads/customer-photo-earbuds-1.svg'
      },
      {
        user_name: 'Dev N.',
        rating: 5,
        title: 'Battery life is unreal',
        comment: 'Used them for 3 days of long Zoom calls and gym sessions on a single case charge. Mic clarity is top notch.',
        photo_url: '/uploads/customer-photo-earbuds-2.svg'
      }
    ]
  },
  {
    name: 'Leather Wallet',
    description: 'Slim minimalist bifold handcrafted with vegetable-tanned leather.',
    long_description: 'Hand-stitched using waxed polycord thread for lifetime structural durability. The natural oils inside the leather burnish and darken with daily use, developing a rich, unique patina unique to your journey.',
    material: 'Full-grain Italian Vegetable-Tanned Pueblo Leather, French Linen Thread.',
    care: 'Condition twice a year with natural beeswax or leather cream. Avoid soaking with water.',
    sizing_guide: 'Closed dimensions: 10.5cm × 8cm × 1.1cm. Accommodates 8-10 cards and flat Indian currency notes comfortably.',
    category: 'Accessories',
    price_paise: 59900,
    stock: 30,
    image: '',
    reviews: [
      {
        user_name: 'Vikram C.',
        rating: 5,
        title: '6 months in and looks even better',
        comment: 'The leather started matte and has now turned into a deep caramel sheen. Disappears in front pockets without creating an unsightly bulge.',
        photo_url: '/uploads/customer-photo-wallet-1.svg'
      },
      {
        user_name: 'Kabir S.',
        rating: 5,
        title: 'Masterful craftsmanship',
        comment: 'Burnished edges, tight stitching, smell of authentic vegetable tanned leather. Worth every rupee.',
        photo_url: '/uploads/customer-photo-wallet-2.svg'
      }
    ]
  },
  {
    name: 'Aero Sneakers',
    description: 'Ultra-lightweight daily runners with responsive foam soles.',
    long_description: 'Designed for seamless transition between high-paced morning runs and all-day city transit. Features anatomical heel-cradle cup, carbon-infused arch stabilization plate, and high-traction rubber lug outsole.',
    material: 'Engineered Recycled Knit Upper, Dual-Density Supercritical Nitrogen EVA Midsole.',
    care: 'Spot clean with gentle damp cloth. Air dry away from direct heat.',
    sizing_guide: 'True to size. Sizes: UK 6 (EU 39) to UK 12 (EU 46). If you have wide feet, order half a size up.',
    category: 'Footwear',
    price_paise: 349900,
    stock: 12,
    image: '',
    reviews: [
      {
        user_name: 'Tanvi D.',
        rating: 5,
        title: 'Like running on morning clouds',
        comment: 'Did my usual 10km morning run on Marine Drive. Zero shin splints and the knit upper breathes so well in Mumbai humidity.',
        photo_url: '/uploads/customer-photo-sneakers-1.svg'
      },
      {
        user_name: 'Zaid H.',
        rating: 5,
        title: 'Styling versatility is unmatched',
        comment: 'Wear them with chinos to casual meetings and with shorts on track. Lightweight and very springy.',
        photo_url: '/uploads/customer-photo-sneakers-2.svg'
      }
    ]
  },
  {
    name: 'Cloud Hoodie',
    description: 'Heavyweight organic cotton fleece with a comfortable relaxed drape.',
    long_description: 'Brushed fleece interior provides cloud-like softness against the skin. Double-layered crossover hood with no drawstrings for a minimal aesthetic, with 2x2 rib side gussets for unhindered mobility.',
    material: '450 GSM Heavyweight 100% Organic French Terry Cotton, Pre-shrunk.',
    care: 'Machine wash cold inside out. Hang dry or tumble dry low. Do not bleach.',
    sizing_guide: 'Boxy, slightly cropped vintage streetwear drape. Sizes: XS, S, M, L, XL, XXL.',
    category: 'Clothing',
    price_paise: 249900,
    stock: 10,
    image: '',
    reviews: [
      {
        user_name: 'Isha V.',
        rating: 5,
        title: 'The heaviest, coziest hoodie I own',
        comment: 'The 450GSM weight gives it that structured architectural silhouette. The hood stands up nicely instead of flopping down.',
        photo_url: '/uploads/customer-photo-hoodie-1.svg'
      },
      {
        user_name: 'Sameer J.',
        rating: 5,
        title: 'Perfect boxy cut',
        comment: 'Went for my normal size L and the drape is immaculate. Extremely soft interior.',
        photo_url: '/uploads/customer-photo-hoodie-2.svg'
      }
    ]
  },
  {
    name: 'Trail Backpack',
    description: '24-litre commuter backpack with waterproof zippers and rain cover.',
    long_description: 'A streamlined expedition-ready commuter pack. Includes suspended padded laptop sleeve, quick-access magnetic transit card pocket, deployable high-visibility rain fly, and breathable 3D air-mesh back panel.',
    material: 'Cordura 500D Weatherproof Ballistic Nylon & YKK AquaGuard Zippers.',
    care: 'Hand wipe with mild soap and lukewarm water. Air dry thoroughly.',
    sizing_guide: 'Capacity: 24 Litres. Dimensions: 48cm × 30cm × 16cm. Suspended sleeve fits laptops up to 16".',
    category: 'Bags',
    price_paise: 179900,
    stock: 9,
    image: '',
    reviews: [
      {
        user_name: 'Pranav B.',
        rating: 5,
        title: 'Perfect work & weekend travel pack',
        comment: 'Easily packed 2 days of clothes, 16-inch MacBook Pro, chargers, and water bottle. Fits easily under airline seats.',
        photo_url: '/uploads/customer-photo-backpack-1.svg'
      }
    ]
  },
  {
    name: 'Slate Watch',
    description: 'Minimalist brushed stainless case with a sapphire glass lens.',
    long_description: 'Driven by an ultra-reliable precision Japanese quartz movement. Features sandblasted slate dial with applied polished gold indices, quick-release Milanese mesh bracelet, and engraved serial number on caseback.',
    material: '316L Surgical Grade Stainless Steel Case & Domed Anti-Reflective Sapphire Crystal.',
    care: '5 ATM Water Resistance (50 meters). Wipe with microfiber cloth.',
    sizing_guide: 'Case Diameter: 39mm. Case Thickness: 8.8mm. Strap Lug Width: 20mm. Fits wrists 15cm to 21cm.',
    category: 'Accessories',
    price_paise: 459900,
    stock: 6,
    image: '',
    reviews: [
      {
        user_name: 'Aditya S.',
        rating: 5,
        title: 'Pure understated elegance',
        comment: 'The sandblasted slate face shifts shade depending on the lighting angle. Clean lines and comfortable mesh strap.',
        photo_url: '/uploads/customer-photo-watch-1.svg'
      }
    ]
  }
];

// Seed or update products with rich details and reviews
for (const p of SEED_CATALOGUE) {
  let existing: any = db.prepare('SELECT id FROM products WHERE name = ?').get(p.name);
  let prodId: number;
  if (!existing) {
    const ins = db.prepare(`
      INSERT INTO products(name, description, long_description, material, care, sizing_guide, category, price_paise, stock, image)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(p.name, p.description, p.long_description, p.material, p.care, p.sizing_guide, p.category, p.price_paise, p.stock, p.image);
    prodId = Number(ins.lastInsertRowid);
  } else {
    prodId = Number(existing.id);
    db.prepare(`
      UPDATE products
      SET long_description = ?, material = ?, care = ?, sizing_guide = ?
      WHERE id = ? AND (long_description IS NULL OR long_description = '')
    `).run(p.long_description, p.material, p.care, p.sizing_guide, prodId);
  }

  // Seed reviews for this product if none exist
  const existingReviews = db.prepare('SELECT 1 FROM reviews WHERE product_id = ?').get(prodId);
  if (!existingReviews && p.reviews) {
    const insRev = db.prepare(`
      INSERT INTO reviews(product_id, user_name, rating, title, comment, photo_url, verified)
      VALUES(?, ?, ?, ?, ?, ?, 1)
    `);
    for (const r of p.reviews) {
      insRev.run(prodId, r.user_name, r.rating, r.title, r.comment, r.photo_url || '');
    }
  }
}

// ---------- Storefront Content (content.json) ----------
const contentFile = path.join(path.dirname(dbPath), 'content.json');
const DEFAULT_CONTENT: Record<string, string> = {
  brand: 'SHOPYK',
  tagline: 'Everything you love, on its way to you.',
  gate_title: 'Welcome to SHOPYK',
  gate_text: 'Sign in to explore products and start shopping.',
  greeting: 'Welcome back, {name}',
  guest_greeting: 'Welcome, guest',
  headline: 'Objects of *everyday distinction.*',
  intro: 'A considered collection of everyday essentials, designed to make the ordinary feel exceptional. Discover pieces chosen for utility, character and lasting style.',
  cta1: 'Explore the collection',
  cta2: 'Meet our contributors',
  sponsors_title: 'Our sponsors',
  sponsors: 'Krishna Pal\nRohan Singh',
  shop_title: 'Objects of *the collection*',
  how_title: 'A more considered *way to shop.*',
  step1_title: 'Browse',
  step1_text: 'Filter by category or search by name.',
  step2_title: 'Add to cart',
  step2_text: 'Change quantities any time. Your cart is saved on this device.',
  step3_title: 'Check out',
  step3_text: 'Enter your delivery details. We will call you to arrange delivery.',
  footer: 'SHOPYK · Considered essentials, selected for you. · Orders are confirmed by phone.'
};

const CONTENT_KEYS = Object.keys(DEFAULT_CONTENT);

function readContent(): Record<string, string> {
  try {
    if (fs.existsSync(contentFile)) {
      const data = JSON.parse(fs.readFileSync(contentFile, 'utf8'));
      return { ...DEFAULT_CONTENT, ...data };
    }
  } catch {}
  return { ...DEFAULT_CONTENT };
}

if (!fs.existsSync(contentFile)) {
  try {
    fs.writeFileSync(contentFile, JSON.stringify(DEFAULT_CONTENT, null, 2), 'utf8');
  } catch {}
}

// ---------- Multer Upload Handlers ----------
const allowedImageTypes: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg'
};

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = allowedImageTypes[file.mimetype] || path.extname(file.originalname) || '.png';
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 6 * 1024 * 1024 },
});

const customizerUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = allowedImageTypes[file.mimetype] || path.extname(file.originalname) || '.png';
      cb(null, 'custom-' + crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 6 * 1024 * 1024 },
});

// ---------- Express Application ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '500kb' }));
app.use(express.urlencoded({ extended: true, limit: '500kb' }));

// Static uploads serving
app.use('/uploads', express.static(uploadDir, {
  dotfiles: 'deny',
  fallthrough: true,
  maxAge: '1h',
}));

// API Cache Control: Prevent stale responses from blocking live admin updates
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ---------- Customer Endpoints ----------

// 1. Get all active products
app.get('/api/products', (_req, res) => {
  const products = db.prepare(`
    SELECT p.id, p.name, p.description, p.category, p.price_paise, p.stock, p.image,
           p.long_description, p.material, p.care, p.sizing_guide,
           (SELECT COUNT(*) FROM reviews WHERE product_id = p.id) as review_count,
           (SELECT AVG(rating) FROM reviews WHERE product_id = p.id) as avg_rating
    FROM products p
    WHERE p.active = 1
    ORDER BY p.id DESC
  `).all();
  res.json(products);
});

// 2. Get single product with full specifications, reviews, and customer photos
app.get('/api/products/:id', (req, res) => {
  const id = Number(req.params.id);
  const p: any = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(id);
  if (!p) {
    return res.status(404).json({ error: 'Product not found' });
  }

  // Get reviews
  const reviews: any[] = db.prepare('SELECT * FROM reviews WHERE product_id = ? ORDER BY id DESC').all(id);

  // Extract customer uploaded photos
  const customerPhotos = reviews
    .filter(r => r.photo_url && r.photo_url.trim() !== '')
    .map(r => ({
      id: r.id,
      photoUrl: r.photo_url,
      userName: r.user_name,
      title: r.title || 'Customer Photo',
      rating: r.rating,
      comment: r.comment,
      date: r.created_at
    }));

  // Calculate rating stats
  const totalReviews = reviews.length;
  const averageRating = totalReviews
    ? Number((reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews).toFixed(1))
    : 5.0;

  const ratingCounts: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const r of reviews) {
    if (ratingCounts[r.rating] !== undefined) {
      ratingCounts[r.rating]++;
    }
  }

  const positive = reviews.filter(r => r.rating >= 4).length;
  const recommendPercent = totalReviews ? Math.round((positive / totalReviews) * 100) : 100;

  res.json({
    ...p,
    reviews,
    customerPhotos,
    stats: {
      averageRating,
      totalReviews,
      ratingCounts,
      recommendPercent
    }
  });
});

// 3. Get reviews for a product
app.get('/api/products/:id/reviews', (req, res) => {
  const id = Number(req.params.id);
  const reviews: any[] = db.prepare('SELECT * FROM reviews WHERE product_id = ? ORDER BY id DESC').all(id);

  const totalReviews = reviews.length;
  const averageRating = totalReviews
    ? Number((reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews).toFixed(1))
    : 5.0;

  const customerPhotos = reviews
    .filter(r => r.photo_url && r.photo_url.trim() !== '')
    .map(r => ({
      id: r.id,
      photoUrl: r.photo_url,
      userName: r.user_name,
      title: r.title,
      rating: r.rating,
      comment: r.comment,
      date: r.created_at
    }));

  res.json({
    reviews,
    customerPhotos,
    totalReviews,
    averageRating
  });
});

// 4. Post a customer review with optional photo
app.post('/api/products/:id/reviews', (req, res, next) => {
  const id = Number(req.params.id);
  imageUpload.single('photo')(req, res, (err: any) => {
    if (err) return next(err);
    try {
      const p = db.prepare('SELECT id FROM products WHERE id = ?').get(id);
      if (!p) return res.status(404).json({ error: 'Product not found' });

      const userName = str(req.body.userName || req.body.user_name, 60) || 'Verified Customer';
      const rating = Math.max(1, Math.min(5, Number(req.body.rating) || 5));
      const title = str(req.body.title, 120);
      const comment = str(req.body.comment || req.body.text, 1000);
      if (!comment) {
        return res.status(400).json({ error: 'Please write a review comment.' });
      }

      const photoUrl = req.file ? '/uploads/' + req.file.filename : (str(req.body.photoUrl, 500) || '');

      const ins = db.prepare(`
        INSERT INTO reviews(product_id, user_name, rating, title, comment, photo_url, verified)
        VALUES(?, ?, ?, ?, ?, ?, 1)
      `).run(id, userName, rating, title, comment, photoUrl);

      const newReview = db.prepare('SELECT * FROM reviews WHERE id = ?').get(Number(ins.lastInsertRowid));
      res.status(201).json(newReview);
    } catch (e: any) {
      next(e);
    }
  });
});

// 5. Post a customer photo directly to the real-life gallery
app.post('/api/products/:id/photos', (req, res, next) => {
  const id = Number(req.params.id);
  imageUpload.single('photo')(req, res, (err: any) => {
    if (err) return next(err);
    try {
      if (!req.file) return res.status(400).json({ error: 'Please choose an image file to upload.' });
      const p = db.prepare('SELECT id FROM products WHERE id = ?').get(id);
      if (!p) return res.status(404).json({ error: 'Product not found' });

      const userName = str(req.body.userName || req.body.user_name, 60) || 'Verified Shopper';
      const caption = str(req.body.caption || req.body.title, 120) || 'Customer Real-life Photo';
      const photoUrl = '/uploads/' + req.file.filename;

      const ins = db.prepare(`
        INSERT INTO reviews(product_id, user_name, rating, title, comment, photo_url, verified)
        VALUES(?, ?, 5, ?, ?, ?, 1)
      `).run(id, userName, caption, caption, photoUrl);

      res.status(201).json({
        id: Number(ins.lastInsertRowid),
        photoUrl,
        userName,
        title: caption
      });
    } catch (e: any) {
      next(e);
    }
  });
});

// 6. Get storefront content (saved by Admin, read by Storefront)
app.get('/api/content', (_req, res) => {
  res.json(readContent());
});

// 7. Customizer upload endpoint (mockups and artwork)
app.post('/api/customizer/upload', (req, res, next) => {
  customizerUpload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'preview', maxCount: 1 }
  ])(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError(413, 'Artwork file must be 5 MB or smaller.'));
      }
      return next(err);
    }
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const artworkFile = files?.image?.[0];
    const previewFile = files?.preview?.[0];

    const artworkUrl = artworkFile ? '/uploads/' + artworkFile.filename : '';
    const previewUrl = previewFile ? '/uploads/' + previewFile.filename : (artworkUrl || '');

    res.status(201).json({
      success: true,
      artworkUrl,
      previewUrl
    });
  });
});

// 8. Place an order
app.post('/api/orders', (req, res) => {
  const c = req.body.customer || {};
  const cust = {
    name: str(c.name, 80),
    phone: str(c.phone, 20).replace(/\D/g, '').slice(-10),
    email: str(c.email, 120),
    address: str(c.address, 300),
    pincode: str(c.pincode, 6),
  };

  if (!cust.name || cust.phone.length !== 10 || !cust.address || !/^\d{6}$/.test(cust.pincode)) {
    throw new HttpError(400, 'Enter your name, 10-digit phone, delivery address and 6-digit pincode.');
  }

  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) {
    throw new HttpError(400, 'Your cart is empty.');
  }

  const getP = db.prepare('SELECT id, name, price_paise, stock FROM products WHERE id = ? AND active = 1');
  const takeStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
  const insOrder = db.prepare(
    'INSERT INTO orders(name, phone, email, address, pincode, total_paise) VALUES(?, ?, ?, ?, ?, ?)'
  );
  const insItem = db.prepare(
    'INSERT INTO order_items(order_id, product_id, name, price_paise, qty, customization) VALUES(?, ?, ?, ?, ?, ?)'
  );

  const orderResult = db.transaction(() => {
    let total = 0;
    const lineEntries: Array<{ p: any; qty: number; customization: string | null }> = [];

    // Verify stock and calculate price from DB
    for (const it of items) {
      const id = Number(it.id || it.productId);
      const qty = Number(it.qty || it.quantity);
      if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 20) {
        throw new HttpError(400, 'Invalid quantity or item in your cart.');
      }

      const p: any = getP.get(id);
      if (!p) {
        throw new HttpError(400, 'An item in your cart is no longer available.');
      }
      if (p.stock < qty) {
        throw new HttpError(409, `Only ${p.stock} left for "${p.name}".`);
      }

      const updated = takeStock.run(qty, id, qty);
      if (!updated.changes) {
        throw new HttpError(409, `Not enough stock remaining for "${p.name}".`);
      }

      total += p.price_paise * qty;
      const customizationStr = it.customization ? JSON.stringify(it.customization) : null;
      lineEntries.push({ p, qty, customization: customizationStr });
    }

    const oid = Number(
      insOrder.run(cust.name, cust.phone, cust.email, cust.address, cust.pincode, total).lastInsertRowid
    );

    for (const line of lineEntries) {
      insItem.run(oid, line.p.id, line.p.name, line.p.price_paise, line.qty, line.customization);
    }

    return { id: oid, total_paise: total };
  })();

  res.status(201).json(orderResult);
});

// ---------- Team Admin Endpoints ----------

const loginLimit = rateLimit({
  windowMs: 15 * 60e3,
  max: 20,
  message: { error: 'Too many sign-in attempts. Please try again in 15 minutes.' }
});

app.post('/api/admin/login', loginLimit, (req, res) => {
  const email = str(req.body.email, 120).toLowerCase();
  const known = Object.hasOwn(ADMINS, email);
  const passwordInput = String(req.body.password ?? '');
  const storedPassword = known ? ADMINS[email] : '';
  const match = crypto.timingSafeEqual(sha(passwordInput), sha(storedPassword));

  if (!known || !match) {
    throw new HttpError(401, 'Invalid email or password.');
  }

  res.json({ token: signToken(email) });
});

// Admin auth barrier
app.use('/api/admin', (req, _res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!readToken(token)) {
    throw new HttpError(401, 'Please sign in to access the admin portal.');
  }
  next();
});

// Admin product image upload
app.post('/api/admin/upload', (req, res, next) => {
  imageUpload.single('image')(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError(413, 'Product image must be 5 MB or smaller.'));
      }
      return next(err);
    }
    if (!req.file) {
      return next(new HttpError(400, 'Please select an image file to upload.'));
    }
    res.status(201).json({ image: '/uploads/' + req.file.filename });
  });
});

function cleanProduct(b: any) {
  const name = str(b.name, 120);
  const price = Math.round(Number(b.price) * 100);
  const stock = Number(b.stock);

  if (!name || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) {
    throw new HttpError(400, 'A product name, positive price, and non-negative integer stock are required.');
  }

  let image = str(b.image, 500);
  if (image && !image.startsWith('http') && !image.startsWith('/')) {
    image = '/' + image;
  }

  const active = (b.active === false || b.active === 'false' || b.active === 0 || b.active === '0') ? 0 : 1;

  return {
    name,
    description: str(b.description, 1000),
    long_description: str(b.long_description, 2000),
    material: str(b.material, 500),
    care: str(b.care, 500),
    sizing_guide: str(b.sizing_guide, 500),
    category: str(b.category, 40) || 'General',
    price_paise: price,
    stock,
    image,
    active,
  };
}

// Get all products (including inactive) for admin
app.get('/api/admin/products', (_req, res) => {
  const allProducts = db.prepare(`
    SELECT p.*,
           (SELECT COUNT(*) FROM reviews WHERE product_id = p.id) as review_count,
           (SELECT AVG(rating) FROM reviews WHERE product_id = p.id) as avg_rating
    FROM products p
    ORDER BY p.id DESC
  `).all();
  res.json(allProducts);
});

// Add new product
app.post('/api/admin/products', (req, res) => {
  const data = cleanProduct(req.body);
  const id = db.prepare(`
    INSERT INTO products(name, description, long_description, material, care, sizing_guide, category, price_paise, stock, image, active)
    VALUES(@name, @description, @long_description, @material, @care, @sizing_guide, @category, @price_paise, @stock, @image, @active)
  `).run(data).lastInsertRowid;

  res.status(201).json({ id: Number(id), success: true });
});

// Update product
app.put('/api/admin/products/:id', (req, res) => {
  const id = Number(req.params.id);
  const data = { ...cleanProduct(req.body), id };
  const r = db.prepare(`
    UPDATE products
    SET name = @name, description = @description, long_description = @long_description,
        material = @material, care = @care, sizing_guide = @sizing_guide,
        category = @category, price_paise = @price_paise, stock = @stock, image = @image, active = @active
    WHERE id = @id
  `).run(data);

  if (!r.changes) {
    throw new HttpError(404, 'Product not found.');
  }
  res.json({ ok: true });
});

// Delete product
app.delete('/api/admin/products/:id', (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('DELETE FROM products WHERE id = ?').run(id);
  if (!r.changes) {
    throw new HttpError(404, 'Product not found.');
  }
  res.json({ ok: true });
});

// Get orders list with customization details
app.get('/api/admin/orders', (_req, res) => {
  const itemStmt = db.prepare('SELECT name, price_paise, qty, customization FROM order_items WHERE order_id = ?');
  const orders: any[] = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all();

  const formatted = orders.map((o) => {
    const rawItems = itemStmt.all(o.id) as Array<{ name: string; price_paise: number; qty: number; customization: string | null }>;
    const items = rawItems.map((i) => {
      let custom = null;
      if (i.customization) {
        try {
          custom = JSON.parse(i.customization);
        } catch {
          custom = null;
        }
      }
      return { ...i, customization: custom };
    });
    return { ...o, items };
  });

  res.json(formatted);
});

// Update order status
const ORDER_STATUSES = ['placed', 'confirmed', 'shipped', 'delivered', 'cancelled'];
app.patch('/api/admin/orders/:id', (req, res) => {
  const status = req.body.status;
  const id = Number(req.params.id);

  if (!ORDER_STATUSES.includes(status)) {
    throw new HttpError(400, 'Invalid status.');
  }

  db.transaction(() => {
    const o: any = db.prepare('SELECT status FROM orders WHERE id = ?').get(id);
    if (!o) throw new HttpError(404, 'Order not found.');
    if (o.status === 'cancelled' && status !== 'cancelled') {
      throw new HttpError(400, 'Cancelled orders cannot be reopened.');
    }
    // Return stock to inventory if order was cancelled
    if (status === 'cancelled' && o.status !== 'cancelled') {
      const items: any[] = db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(id);
      for (const item of items) {
        if (item.product_id) {
          db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.qty, item.product_id);
        }
      }
    }
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
  })();

  res.json({ ok: true });
});

// Save Storefront Content
app.put('/api/admin/content', (req, res) => {
  const current = readContent();
  const updated: Record<string, string> = { ...current };

  for (const k of CONTENT_KEYS) {
    if (typeof req.body[k] === 'string') {
      updated[k] = req.body[k].trim().slice(0, 2000);
    }
  }

  fs.writeFileSync(contentFile, JSON.stringify(updated, null, 2), 'utf8');
  res.json(updated);
});

// ---------- Static serving / Vite dev integration ----------

// Serve admin website directly at /admin and /admin/*
app.use('/admin', express.static(path.join(__dirname, 'admin'), { index: 'index.html' }));
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// In development, mount Vite middleware to serve storefront & handle modules
const isProd = process.env.NODE_ENV === 'production';
if (!isProd) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  // In production, serve dist assets
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
}

// Global error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || 500;
  if (status >= 500) console.error('Server error:', err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side.' : err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SHOPYK Server started on port ${PORT}`);
  console.log(`Storefront: http://localhost:${PORT}`);
  console.log(`Admin Portal: http://localhost:${PORT}/admin`);
});
