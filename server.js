// ============================================================
// DUB NUMBER - PRODUCTION BACKEND
// 5SIM VERSION
// ============================================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const { z } = require('zod');

// ============================================================
// 1. LOGGER
// ============================================================

const logger = winston.createLogger({
level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
format: winston.format.combine(
winston.format.timestamp(),
winston.format.errors({ stack: true }),
winston.format.json()
),
transports: [
new winston.transports.File({ filename: 'error.log', level: 'error' }),
new winston.transports.File({ filename: 'combined.log' })
]
});

if (process.env.NODE_ENV !== 'production') {
logger.add(new winston.transports.Console({ format: winston.format.simple() }));
}

// ============================================================
// 2. ENVIRONMENT
// ============================================================

const requiredEnv = [
'NODE_ENV',
'DATABASE_URL',
'FIREBASE_PROJECT_ID',
'FIREBASE_PRIVATE_KEY',
'FIREBASE_CLIENT_EMAIL',
'FIVESIM_API_KEY',
'FLW_SECRET_KEY',
'FLW_SECRET_HASH',
'USD_NGN_RATE',
'MARKUP_PERCENT'
];

const missingEnv = requiredEnv.filter(key => !process.env[key]);

if (missingEnv.length) {
console.error(`❌ Missing required environment variables: ${missingEnv.join(', ')}`);
process.exit(1);
}

const config = {
port: parseInt(process.env.PORT, 10) || 5000,
nodeEnv: process.env.NODE_ENV,
frontendUrls: (process.env.FRONTEND_URL || 'http://localhost:5500').split(',').map(u => u.trim()),
backendUrl: process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:5000',
usdNgnRate: parseFloat(process.env.USD_NGN_RATE),
markupPercent: parseFloat(process.env.MARKUP_PERCENT)
};

if (Number.isNaN(config.usdNgnRate) || config.usdNgnRate <= 0) {
console.error('❌ USD_NGN_RATE must be a positive number');
process.exit(1);
}

if (Number.isNaN(config.markupPercent) || config.markupPercent < 0) {
console.error('❌ MARKUP_PERCENT must be a non-negative number');
process.exit(1);
}

// ============================================================
// 3. DATABASE
// ============================================================

const pool = new Pool({
connectionString: process.env.DATABASE_URL,
max: 20,
idleTimeoutMillis: 30000,
connectionTimeoutMillis: 10000,
ssl: { rejectUnauthorized: false }
});

pool.on('error', err => {
logger.error('Unexpected database error', { error: err.message });
});

async function query(text, params) {
const start = Date.now();
try {
const result = await pool.query(text, params);
const duration = Date.now() - start;
if (duration > 1000) {
logger.warn('Slow query', { text: text.substring(0, 100), duration });
}
return result;
} catch (error) {
logger.error('Query error', { error: error.message, text: text.substring(0, 100) });
throw error;
}
}

async function getClient() {
const client = await pool.connect();
const originalQuery = client.query;
const originalRelease = client.release;

client.query = (...args) => {
const start = Date.now();
return originalQuery.apply(client, args)
.then(result => {
const duration = Date.now() - start;
if (duration > 1000) {
logger.warn('Slow transaction query', { text: args[0]?.substring(0, 100), duration });
}
return result;
})
.catch(error => {
logger.error('Transaction query error', { text: args[0]?.substring(0, 100), error: error.message });
throw error;
});
};

client.release = () => {
client.query = originalQuery;
client.release = originalRelease;
originalRelease.call(client);
};

return client;
}

// ============================================================
// 4. FIREBASE
// ============================================================

try {
admin.initializeApp({
credential: admin.credential.cert({
projectId: process.env.FIREBASE_PROJECT_ID,
privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
clientEmail: process.env.FIREBASE_CLIENT_EMAIL
})
});
logger.info('Firebase Admin initialized');
} catch (error) {
logger.error('Firebase initialization failed', { error: error.message });
process.exit(1);
}

// ============================================================
// 5. MIGRATIONS
// ============================================================

const MIGRATIONS = {
'001_initial': `
CREATE TABLE IF NOT EXISTS users (
id SERIAL PRIMARY KEY,
firebase_uid VARCHAR(255) UNIQUE NOT NULL,
email VARCHAR(255) UNIQUE NOT NULL,
name VARCHAR(100) NOT NULL,
wallet_balance NUMERIC(15,2) DEFAULT 0.00 CHECK (wallet_balance >= 0),
is_admin BOOLEAN DEFAULT FALSE,
is_blocked BOOLEAN DEFAULT FALSE,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS wallet_transactions (
id SERIAL PRIMARY KEY,
user_id INTEGER REFERENCES users(id) NOT NULL,
type VARCHAR(10) NOT NULL CHECK(type IN ('credit','debit')),
amount NUMERIC(15,2) NOT NULL CHECK(amount > 0),
balance_before NUMERIC(15,2) NOT NULL,
balance_after NUMERIC(15,2) NOT NULL,
description TEXT,
reference VARCHAR(100) UNIQUE NOT NULL,
metadata JSONB,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_id ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_reference ON wallet_transactions(reference);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_at ON wallet_transactions(created_at);

CREATE TABLE IF NOT EXISTS payments (
id SERIAL PRIMARY KEY,
user_id INTEGER REFERENCES users(id) NOT NULL,
tx_ref VARCHAR(100) UNIQUE NOT NULL,
flutterwave_transaction_id VARCHAR(100),
amount NUMERIC(15,2) NOT NULL,
currency VARCHAR(3) DEFAULT 'NGN',
status VARCHAR(20) DEFAULT 'pending',
metadata JSONB,
processed_at TIMESTAMP,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_flutterwave_tx_id ON payments(flutterwave_transaction_id) WHERE flutterwave_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_tx_ref ON payments(tx_ref);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

CREATE TABLE IF NOT EXISTS purchases (
id SERIAL PRIMARY KEY,
user_id INTEGER REFERENCES users(id) NOT NULL,
product_type VARCHAR(20) NOT NULL,
provider VARCHAR(50) NOT NULL,
provider_order_id VARCHAR(255),
country VARCHAR(50),
service VARCHAR(50),
provider_cost NUMERIC(15,2),
customer_price NUMERIC(15,2),
currency VARCHAR(3) DEFAULT 'NGN',
status VARCHAR(20) DEFAULT 'pending',
expires_at TIMESTAMP,
metadata JSONB,
idempotency_key VARCHAR(255) UNIQUE NOT NULL,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_purchases_user_id ON purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_provider_order_id ON purchases(provider_order_id);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);

CREATE TABLE IF NOT EXISTS refunds (
id SERIAL PRIMARY KEY,
user_id INTEGER REFERENCES users(id) NOT NULL,
purchase_id INTEGER REFERENCES purchases(id),
amount NUMERIC(15,2) NOT NULL,
reason VARCHAR(255) NOT NULL,
status VARCHAR(20) DEFAULT 'pending',
provider_refund_id VARCHAR(255),
wallet_transaction_id INTEGER REFERENCES wallet_transactions(id),
metadata JSONB,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
id SERIAL PRIMARY KEY,
type VARCHAR(50) NOT NULL,
description TEXT NOT NULL,
data JSONB,
resolved BOOLEAN DEFAULT FALSE,
resolved_at TIMESTAMP,
resolved_by INTEGER REFERENCES users(id),
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
NEW.updated_at = CURRENT_TIMESTAMP;
RETURN NEW;
END;
$$ language 'plpgsql';

DO $$
BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_users_updated_at') THEN
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
END IF;
IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_payments_updated_at') THEN
CREATE TRIGGER update_payments_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
END IF;
IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_purchases_updated_at') THEN
CREATE TRIGGER update_purchases_updated_at BEFORE UPDATE ON purchases FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
END IF;
IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_refunds_updated_at') THEN
CREATE TRIGGER update_refunds_updated_at BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
END IF;
END $$;
`
};

async function runMigrations() {
const tableCheck = await query(`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'migrations')`);

if (!tableCheck.rows[0].exists) {
await query(`CREATE TABLE migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) UNIQUE NOT NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
}

for (const [name, sql] of Object.entries(MIGRATIONS)) {
const applied = await query(`SELECT 1 FROM migrations WHERE name = $1`, [name]);
if (!applied.rows.length) {
logger.info(`Applying migration: ${name}`);
await query(sql);
await query(`INSERT INTO migrations(name) VALUES($1)`, [name]);
}
}
logger.info('All migrations completed');
}

// ============================================================
// 6. VALIDATION
// ============================================================

const schemas = {
topup: z.object({
amount: z.number().positive().min(100, 'Minimum top-up is ₦100')
}).or(z.object({
amount: z.string().regex(/^\d+$/).transform(Number).refine(n => n >= 100, 'Minimum top-up is ₦100')
})),
buyNumber: z.object({
service: z.string().min(1).max(50),
country: z.string().min(1).max(50),
period: z.string().max(20).optional(),
areaCode: z.string().regex(/^\d{1,5}$/).optional()
}),
adminAdjustment: z.object({
userId: z.number().positive().or(z.string().regex(/^\d+$/).transform(Number)),
amount: z.number().positive().or(z.string().regex(/^\d+\.?\d*$/).transform(Number)),
direction: z.enum(['credit', 'debit']),
reason: z.string().min(5).max(500)
}),
idempotencyKey: z.string().min(10).max(100)
};

function validate(schema) {
return async (req, res, next) => {
const result = await schema.safeParseAsync(req.body);
if (!result.success) {
return res.status(400).json({
error: 'Validation failed',
details: result.error.errors.map(e => ({ path: e.path.join('.'), message: e.message }))
});
}
req.body = result.data;
next();
};
}

// ============================================================
// 7. AUTH
// ============================================================

const authMiddleware = async (req, res, next) => {
try {
const authHeader = req.headers.authorization;
if (!authHeader || !authHeader.startsWith('Bearer ')) {
return res.status(401).json({ error: 'No token provided' });
}

const idToken = authHeader.substring(7);
const decodedToken = await admin.auth().verifyIdToken(idToken);
const firebaseUid = decodedToken.uid;

let user = await query(`SELECT * FROM users WHERE firebase_uid = $1`, [firebaseUid]);

if (!user.rows.length) {
const firebaseUser = await admin.auth().getUser(firebaseUid);
const result = await query(
`INSERT INTO users (firebase_uid, email, name, wallet_balance) VALUES($1,$2,$3,0) RETURNING *`,
[firebaseUid, firebaseUser.email, firebaseUser.displayName || 'User']
);
user = result;
}

if (user.rows[0].is_blocked) {
return res.status(403).json({ error: 'Account blocked' });
}

req.user = user.rows[0];
req.userId = user.rows[0].id;
req.firebaseUid = firebaseUid;
next();

} catch (error) {
logger.error('Auth error', { error: error.message });
return res.status(401).json({ error: 'Authentication failed' });
}
};

const adminMiddleware = (req, res, next) => {
if (!req.user || !req.user.is_admin) {
return res.status(403).json({ error: 'Admin access required' });
}
next();
};

// ============================================================
// 8. RATE LIMITING
// ============================================================

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: 'Too many requests, please try again later.' });
const servicesLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 2000, message: 'Too many requests, please try again later.' });
const purchaseLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: 'Too many purchase attempts, please try again later.' });
const topupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many top-up attempts, please try again later.' });

// ============================================================
// 9. 5SIM PROVIDER
// ============================================================

const fivesimClient = axios.create({
baseURL: process.env.FIVESIM_BASE_URL || 'https://5sim.net/v1',
headers: {
Authorization: `Bearer ${process.env.FIVESIM_API_KEY}`,
Accept: 'application/json'
},
timeout: 30000
});

const FIVESIM_COUNTRIES = {
US: { name: 'usa', displayName: 'United States', flag: '🇺🇸' },
GB: { name: 'england', displayName: 'United Kingdom', flag: '🇬🇧' },
CA: { name: 'canada', displayName: 'Canada', flag: '🇨🇦' },
AU: { name: 'australia', displayName: 'Australia', flag: '🇦🇺' },
FR: { name: 'france', displayName: 'France', flag: '🇫🇷' },
DE: { name: 'germany', displayName: 'Germany', flag: '🇩🇪' },
IT: { name: 'italy', displayName: 'Italy', flag: '🇮🇹' },
ES: { name: 'spain', displayName: 'Spain', flag: '🇪🇸' },
NL: { name: 'netherlands', displayName: 'Netherlands', flag: '🇳🇱' },
BE: { name: 'belgium', displayName: 'Belgium', flag: '🇧🇪' },
CH: { name: 'switzerland', displayName: 'Switzerland', flag: '🇨🇭' },
AT: { name: 'austria', displayName: 'Austria', flag: '🇦🇹' },
SE: { name: 'sweden', displayName: 'Sweden', flag: '🇸🇪' },
NO: { name: 'norway', displayName: 'Norway', flag: '🇳🇴' },
DK: { name: 'denmark', displayName: 'Denmark', flag: '🇩🇰' },
FI: { name: 'finland', displayName: 'Finland', flag: '🇫🇮' },
IE: { name: 'ireland', displayName: 'Ireland', flag: '🇮🇪' },
PT: { name: 'portugal', displayName: 'Portugal', flag: '🇵🇹' },
PL: { name: 'poland', displayName: 'Poland', flag: '🇵🇱' },
CZ: { name: 'czech-republic', displayName: 'Czech Republic', flag: '🇨🇿' },
HU: { name: 'hungary', displayName: 'Hungary', flag: '🇭🇺' },
RO: { name: 'romania', displayName: 'Romania', flag: '🇷🇴' },
BG: { name: 'bulgaria', displayName: 'Bulgaria', flag: '🇧🇬' },
GR: { name: 'greece', displayName: 'Greece', flag: '🇬🇷' },
IN: { name: 'india', displayName: 'India', flag: '🇮🇳' },
ID: { name: 'indonesia', displayName: 'Indonesia', flag: '🇮🇩' },
PK: { name: 'pakistan', displayName: 'Pakistan', flag: '🇵🇰' },
BD: { name: 'bangladesh', displayName: 'Bangladesh', flag: '🇧🇩' },
VN: { name: 'vietnam', displayName: 'Vietnam', flag: '🇻🇳' },
PH: { name: 'philippines', displayName: 'Philippines', flag: '🇵🇭' },
MY: { name: 'malaysia', displayName: 'Malaysia', flag: '🇲🇾' },
TH: { name: 'thailand', displayName: 'Thailand', flag: '🇹🇭' },
SG: { name: 'singapore', displayName: 'Singapore', flag: '🇸🇬' },
JP: { name: 'japan', displayName: 'Japan', flag: '🇯🇵' },
KR: { name: 'south-korea', displayName: 'South Korea', flag: '🇰🇷' },
AE: { name: 'uae', displayName: 'UAE', flag: '🇦🇪' },
SA: { name: 'saudi-arabia', displayName: 'Saudi Arabia', flag: '🇸🇦' },
TR: { name: 'turkey', displayName: 'Turkey', flag: '🇹🇷' },
BR: { name: 'brazil', displayName: 'Brazil', flag: '🇧🇷' },
AR: { name: 'argentina', displayName: 'Argentina', flag: '🇦🇷' },
CO: { name: 'colombia', displayName: 'Colombia', flag: '🇨🇴' },
CL: { name: 'chile', displayName: 'Chile', flag: '🇨🇱' },
PE: { name: 'peru', displayName: 'Peru', flag: '🇵🇪' },
ZA: { name: 'south-africa', displayName: 'South Africa', flag: '🇿🇦' },
NG: { name: 'nigeria', displayName: 'Nigeria', flag: '🇳🇬' },
GH: { name: 'ghana', displayName: 'Ghana', flag: '🇬🇭' },
KE: { name: 'kenya', displayName: 'Kenya', flag: '🇰🇪' },
EG: { name: 'egypt', displayName: 'Egypt', flag: '🇪🇬' },
MA: { name: 'morocco', displayName: 'Morocco', flag: '🇲🇦' },
TN: { name: 'tunisia', displayName: 'Tunisia', flag: '🇹🇳' },
UG: { name: 'uganda', displayName: 'Uganda', flag: '🇺🇬' },
TZ: { name: 'tanzania', displayName: 'Tanzania', flag: '🇹🇿' },
ZM: { name: 'zambia', displayName: 'Zambia', flag: '🇿🇲' },
ZW: { name: 'zimbabwe', displayName: 'Zimbabwe', flag: '🇿🇼' },
NZ: { name: 'new-zealand', displayName: 'New Zealand', flag: '🇳🇿' },
MX: { name: 'mexico', displayName: 'Mexico', flag: '🇲🇽' },
PR: { name: 'puerto-rico', displayName: 'Puerto Rico', flag: '🇵🇷' },
IL: { name: 'israel', displayName: 'Israel', flag: '🇮🇱' },
HK: { name: 'hong-kong', displayName: 'Hong Kong', flag: '🇭🇰' },
TW: { name: 'taiwan', displayName: 'Taiwan', flag: '🇹🇼' }
};

function resolve5SimCountry(country) {
if (!country) throw new Error('Country is required');
const value = String(country).trim().toUpperCase();
if (FIVESIM_COUNTRIES[value]) return FIVESIM_COUNTRIES[value];
const byName = Object.values(FIVESIM_COUNTRIES).find(c => c.name.toUpperCase() === String(country).trim().toUpperCase());
if (byName) return byName;
return {
name: String(country).trim().toLowerCase().replace(/\s+/g, '-'),
displayName: String(country).trim(),
flag: '🌍'
};
}

async function fivesimGetPrices(country, product = null) {
const countryInfo = resolve5SimCountry(country);
const params = { country: countryInfo.name };
if (product) params.product = String(product).trim().toLowerCase();

try {
const response = await fivesimClient.get('/guest/prices', { params });
return response.data;
} catch (error) {
logger.error('5SIM prices failed', { error: error.response?.data || error.message, country, product });
throw new Error('Failed to get 5SIM prices');
}
}

function normalize5SimPrices(data, country) {
const result = [];
const countryInfo = resolve5SimCountry(country);
const countryData = data?.[countryInfo.name] || data?.[String(country).toLowerCase()] || data;

if (!countryData || typeof countryData !== 'object') return result;

for (const [product, operators] of Object.entries(countryData)) {
if (!operators || typeof operators !== 'object') continue;
for (const [operator, info] of Object.entries(operators)) {
if (!info || typeof info !== 'object') continue;
const cost = Number(info.cost);
const count = Number(info.count);
if (!Number.isFinite(cost) || cost <= 0) continue;
result.push({
id: `${product}_${operator}`,
service: product,
name: product,
operator,
price: cost,
stock: Number.isFinite(count) ? count : 0,
currency: 'USD',
country: countryInfo.name,
countryCode: String(country).toUpperCase(),
rate: info.rate ?? null
});
}
}
return result;
}

async function fivesimGetServices(country) {
const prices = await fivesimGetPrices(country);
return normalize5SimPrices(prices, country);
}

async function fivesimGetPrice(service, country) {
const services = await fivesimGetServices(country);

let requested = String(service).trim().toLowerCase();

const knownOperators = ['any', 'mts', 'megafon', 'beeline', 'tele2', 'vodafone', 'o2', 'ee', 'three', 'orange', 'sfr', 'bouygues', 't-mobile', 'att', 'verizon', 'sprint', 'tmobile', 'virgin', 'plus', 'play', 'wind', 'tim', '3', 'telenor', 'telia', 'elisa', 'optus', 'telstra', 'singtel', 'starhub', 'm1', 'globe', 'smart', 'sun', 'dtac', 'ais', 'true', 'jio', 'airtel', 'vi', 'bsnl', 'mtn', 'glo', '9mobile', 'vodacom', 'safaricom', 'airtel', 'orange', 'moov', 'etisalat', 'du', 'stc', 'zain', 'mobily', 'jawwy', 'giffgaff', 'lycamobile', 'lebara', 'talkmobile'];

const parts = requested.split('_');
if (parts.length >= 2) {
const lastPart = parts[parts.length - 1];
if (knownOperators.includes(lastPart)) {
requested = parts.slice(0, -1).join('_');
logger.debug(`fivesimGetPrice: Extracted product name: ${requested} from service: ${service}`);
}
}

const matches = services.filter(item => item.service.toLowerCase() === requested);
if (!matches.length) {
throw new Error(`No ${service} numbers available in ${country}`);
}

const available = matches.filter(item => item.stock > 0).sort((a, b) => a.price - b.price);
const selected = available[0] || matches.sort((a, b) => a.price - b.price)[0];

return {
price: selected.price,
currency: 'USD',
stock: selected.stock,
operator: selected.operator,
service: selected.service,
country: selected.country
};
}

async function fivesimBuyNumber(service, country, options = {}) {
const countryInfo = resolve5SimCountry(country);
const operator = options.operator || 'any';
let product = String(service).trim().toLowerCase();

const knownOperators = ['any', 'mts', 'megafon', 'beeline', 'tele2', 'vodafone', 'o2', 'ee', 'three', 'orange', 'sfr', 'bouygues', 't-mobile', 'att', 'verizon', 'sprint', 'tmobile', 'virgin', 'plus', 'play', 'wind', 'tim', '3', 'telenor', 'telia', 'elisa', 'optus', 'telstra', 'singtel', 'starhub', 'm1', 'globe', 'smart', 'sun', 'dtac', 'ais', 'true', 'jio', 'airtel', 'vi', 'bsnl', 'mtn', 'glo', '9mobile', 'vodacom', 'safaricom', 'airtel', 'orange', 'moov', 'etisalat', 'du', 'stc', 'zain', 'mobily', 'jawwy', 'giffgaff', 'lycamobile', 'lebara', 'talkmobile'];

const parts = product.split('_');
if (parts.length >= 2) {
const lastPart = parts[parts.length - 1];
if (knownOperators.includes(lastPart)) {
product = parts.slice(0, -1).join('_');
logger.debug(`fivesimBuyNumber: Extracted product name: ${product} from service: ${service}`);
}
}

const params = {};
if (options.forwarding) params.forwarding = '1';
if (options.number) params.number = options.number;
if (options.reuse) params.reuse = '1';
if (options.voice) params.voice = '1';
if (options.maxPrice) params.maxPrice = options.maxPrice;

try {
logger.info(`5SIM buy: country=${countryInfo.name}, operator=${operator}, product=${product}`);
const response = await fivesimClient.get(
`/user/buy/activation/${encodeURIComponent(countryInfo.name)}/${encodeURIComponent(operator)}/${encodeURIComponent(product)}`,
{ params }
);
const data = response.data;
if (!data || !data.id || !data.phone) {
throw new Error('Invalid response from 5SIM');
}
return {
id: data.id,
number: data.phone,
phone: data.phone,
operator: data.operator,
service: data.product,
service_name: data.product,
price: Number(data.price),
end_time: data.expires,
expires: data.expires,
status: data.status,
country: data.country,
sms: data.sms || [],
raw: data
};
} catch (error) {
logger.error('5SIM buy failed', { service, country, product, operator, error: error.response?.data || error.message });
const providerError = error.response?.data;
if (providerError?.message) throw new Error(providerError.message);
if (typeof providerError === 'string') throw new Error(providerError);
throw new Error('Failed to purchase number from 5SIM');
}
}

async function fivesimGetOrder(orderId) {
try {
const response = await fivesimClient.get(`/user/check/${encodeURIComponent(orderId)}`);
return response.data;
} catch (error) {
logger.error('5SIM check failed', { orderId, error: error.response?.data || error.message });
throw new Error('Failed to check 5SIM order');
}
}

async function fivesimGetMessages(orderId) {
try {
const data = await fivesimGetOrder(orderId);
const sms = Array.isArray(data.sms) ? data.sms : [];
return sms.map(message => ({
text: message.text || message.message || '',
code: message.code || null,
sender: message.sender || null,
time: message.created_at || message.date || new Date().toISOString()
}));
} catch (error) {
logger.error('5SIM messages failed', { orderId, error: error.message });
return [];
}
}

async function fivesimCancelRental(orderId) {
try {
const response = await fivesimClient.get(`/user/cancel/${encodeURIComponent(orderId)}`);
const data = response.data;
return {
success: data.status === 'CANCELED',
refunded: data.status === 'CANCELED',
refundId: String(data.id),
data
};
} catch (error) {
logger.error('5SIM cancel failed', { orderId, error: error.response?.data || error.message });
throw new Error('Failed to cancel 5SIM order');
}
}

// ============================================================
// 10. FLUTTERWAVE
// ============================================================

const flwClient = axios.create({
baseURL: 'https://api.flutterwave.com/v3',
headers: {
Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
'Content-Type': 'application/json'
},
timeout: 60000 // Increased to 60 seconds
});

async function flwInitializePayment(data) {
try {
const response = await flwClient.post('/payments', {
tx_ref: data.tx_ref,
amount: data.amount,
currency: 'NGN',
redirect_url: data.redirect_url,
customer: { email: data.email, name: data.name },
meta: { user_id: data.user_id }
});
return response.data.data;
} catch (error) {
logger.error('Flutterwave initialize failed', { error: error.response?.data || error.message });
throw new Error('Failed to initialize payment');
}
}

async function flwVerifyPayment(transactionId) {
try {
console.log(`📞 Calling Flutterwave verify API for transaction: ${transactionId}`);
const response = await flwClient.get(`/transactions/${transactionId}/verify`);
console.log(`📞 Flutterwave verify response status: ${response.data.status}`);
return response.data.data;
} catch (error) {
console.error(`❌ Flutterwave verify failed:`, error.response?.data || error.message);
logger.error('Flutterwave verify failed', { error: error.response?.data || error.message });
throw new Error('Failed to verify payment');
}
}

function flwVerifyWebhookSignature(rawBody, signature) {
if (!signature) {
console.log('❌ No signature provided in webhook');
return false;
}

const expected = crypto.createHmac('sha256', process.env.FLW_SECRET_HASH).update(rawBody).digest('hex');
console.log(`📞 Webhook signature check - Expected: ${expected.substring(0, 20)}..., Received: ${signature.substring(0, 20)}...`);

try {
const result = crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'));
console.log(`📞 Signature verification result: ${result}`);
return result;
} catch (error) {
console.error(`❌ Signature verification error:`, error.message);
return false;
}
}

// ============================================================
// 11. WALLET
// ============================================================

async function walletGetBalance(userId) {
const result = await query(`SELECT wallet_balance FROM users WHERE id = $1`, [userId]);
if (!result.rows.length) throw new Error('User not found');
return result.rows[0].wallet_balance;
}

async function walletGetTransactions(userId, limit = 50, offset = 0) {
const result = await query(
`SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
[userId, limit, offset]
);
return result.rows;
}

async function walletDebit(userId, amount, description, reference, metadata = {}) {
if (amount <= 0) throw new Error('Amount must be positive');
const client = await getClient();

try {
await client.query('BEGIN');
const user = await client.query(`SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]);
if (!user.rows.length) throw new Error('User not found');

const before = user.rows[0].wallet_balance;
const sufficient = await client.query(`SELECT $1::NUMERIC >= $2::NUMERIC AS sufficient`, [before, amount]);
if (!sufficient.rows[0].sufficient) throw new Error('Insufficient balance');

const updated = await client.query(
`UPDATE users SET wallet_balance = wallet_balance - $1::NUMERIC WHERE id = $2 RETURNING wallet_balance`,
[amount, userId]
);
const after = updated.rows[0].wallet_balance;

const tx = await client.query(
`INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, description, reference, metadata) VALUES ($1, 'debit', $2, $3, $4, $5, $6, $7) RETURNING id`,
[userId, amount, before, after, description, reference, metadata]
);

await client.query('COMMIT');
return { success: true, amount, balanceBefore: before, balanceAfter: after, transactionId: tx.rows[0].id };
} catch (error) {
await client.query('ROLLBACK');
throw error;
} finally {
client.release();
}
}

async function walletCredit(userId, amount, description, reference, metadata = {}) {
if (amount <= 0) throw new Error('Amount must be positive');
const client = await getClient();

try {
await client.query('BEGIN');
const user = await client.query(`SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]);
if (!user.rows.length) throw new Error('User not found');

const before = user.rows[0].wallet_balance;
const updated = await client.query(
`UPDATE users SET wallet_balance = wallet_balance + $1::NUMERIC WHERE id = $2 RETURNING wallet_balance`,
[amount, userId]
);
const after = updated.rows[0].wallet_balance;

const tx = await client.query(
`INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, description, reference, metadata) VALUES ($1, 'credit', $2, $3, $4, $5, $6, $7) RETURNING id`,
[userId, amount, before, after, description, reference, metadata]
);

await client.query('COMMIT');
return { success: true, amount, balanceBefore: before, balanceAfter: after, transactionId: tx.rows[0].id };
} catch (error) {
await client.query('ROLLBACK');
throw error;
} finally {
client.release();
}
}

// ============================================================
// 12. NUMBER SERVICE
// ============================================================

const PURCHASE_STATES = {
PENDING: 'pending',
PROCESSING: 'processing',
ACTIVE: 'active',
FAILED: 'failed',
CANCELLED: 'cancelled',
EXPIRED: 'expired',
REFUNDED: 'refunded'
};

async function calculatePriceInDb(providerCost, currency = 'USD') {
const result = await query(
`SELECT CASE WHEN $2 = 'USD' THEN $1::NUMERIC * $3::NUMERIC * (1 + $4::NUMERIC / 100) ELSE $1::NUMERIC * (1 + $4::NUMERIC / 100) END AS price`,
[providerCost, currency, config.usdNgnRate, config.markupPercent]
);
return parseFloat(result.rows[0].price);
}

async function numbersBuy(userId, service, country, options = {}) {
const client = await getClient();
let idempotencyKey = options.idempotencyKey;

if (!idempotencyKey) {
idempotencyKey = `${userId}-${service}-${country}-${Date.now()}-${uuidv4().substring(0, 8)}`;
}

try {
await client.query('BEGIN');
const existing = await client.query(`SELECT * FROM purchases WHERE idempotency_key = $1 FOR UPDATE`, [idempotencyKey]);

if (existing.rows.length) {
await client.query('COMMIT');
return existing.rows[0];
}
await client.query('COMMIT');

// Get live 5SIM price
let providerPrice;
try {
providerPrice = await fivesimGetPrice(service, country);
} catch (error) {
await query(
`INSERT INTO purchases (user_id, product_type, provider, country, service, status, idempotency_key, metadata) VALUES ($1, 'number', '5sim', $2, $3, 'failed', $4, $5)`,
[userId, country, service, idempotencyKey, { error: error.message }]
);
throw error;
}

const customerPrice = await calculatePriceInDb(providerPrice.price, 'USD');

// Create pending purchase
await client.query('BEGIN');
const pending = await client.query(
`INSERT INTO purchases (user_id, product_type, provider, country, service, status, idempotency_key) VALUES ($1, 'number', '5sim', $2, $3, 'pending', $4) RETURNING id`,
[userId, country, service, idempotencyKey]
);
const purchaseId = pending.rows[0].id;

const wallet = await client.query(`SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]);
if (!wallet.rows.length) throw new Error('User not found');

const balance = wallet.rows[0].wallet_balance;
const sufficient = await client.query(`SELECT $1::NUMERIC >= $2::NUMERIC AS sufficient`, [balance, customerPrice]);

if (!sufficient.rows[0].sufficient) {
await client.query(`UPDATE purchases SET status = 'failed', metadata = $1 WHERE id = $2`, [{ error: 'Insufficient balance' }, purchaseId]);
await client.query('COMMIT');
throw new Error('Insufficient balance');
}
await client.query('COMMIT');

// Buy from 5SIM
let rental;
try {
rental = await fivesimBuyNumber(providerPrice.service, country, options);
} catch (error) {
await query(`UPDATE purchases SET status = 'failed', metadata = $1 WHERE id = $2`, [{ error: error.message }, purchaseId]);
throw new Error('Provider service unavailable');
}

// Debit wallet only after provider success
await client.query('BEGIN');

const finalWallet = await client.query(`SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]);
const finalBalance = finalWallet.rows[0].wallet_balance;
const finalCheck = await client.query(`SELECT $1::NUMERIC >= $2::NUMERIC AS sufficient`, [finalBalance, customerPrice]);

if (!finalCheck.rows[0].sufficient) {
await client.query(
`UPDATE purchases SET provider_order_id = $1, status = 'failed', metadata = $2 WHERE id = $3`,
[String(rental.id), { error: 'Provider rented but wallet insufficient' }, purchaseId]
);
await client.query('COMMIT');

await query(
`INSERT INTO reconciliation_exceptions (type, description, data) VALUES ($1,$2,$3)`,
['provider_rental_without_payment', `5SIM rented ${rental.id} but wallet was insufficient`, { purchaseId, providerRentalId: rental.id, userId }]
);
throw new Error('Balance changed during purchase process');
}

const oldBalance = finalBalance;
const newBalance = await client.query(
`UPDATE users SET wallet_balance = wallet_balance - $1::NUMERIC WHERE id = $2 RETURNING wallet_balance`,
[customerPrice, userId]
);
const balanceAfter = newBalance.rows[0].wallet_balance;

const result = await client.query(
`UPDATE purchases SET provider_order_id = $1, provider_cost = $2, customer_price = $3, currency = 'NGN', expires_at = $4, status = 'active', metadata = $5 WHERE id = $6 RETURNING *`,
[String(rental.id), rental.price, customerPrice, rental.expires ? new Date(rental.expires) : null, { providerOrder: rental.raw || rental }, purchaseId]
);

await client.query(
`INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, description, reference, metadata) VALUES ($1, 'debit', $2, $3, $4, $5, $6, $7)`,
[userId, customerPrice, oldBalance, balanceAfter, `Number purchase: ${country} - ${service}`, `5SIM-${rental.id}`, { purchase_id: purchaseId, provider: '5sim', provider_order_id: String(rental.id) }]
);

await client.query('COMMIT');
return { ...result.rows[0], number: rental.number, expiresAt: rental.expires };

} catch (error) {
try { await client.query('ROLLBACK'); } catch {}
logger.error('Buy number failed', { userId, service, country, error: error.message });
throw error;
} finally {
client.release();
}
}

async function numbersGetUserRentals(userId) {
const result = await query(
`SELECT * FROM purchases WHERE user_id = $1 AND product_type = 'number' ORDER BY created_at DESC`,
[userId]
);
return result.rows;
}

async function numbersCancel(userId, purchaseId) {
const client = await getClient();

try {
await client.query('BEGIN');
const purchase = await client.query(`SELECT * FROM purchases WHERE id = $1 AND user_id = $2 FOR UPDATE`, [purchaseId, userId]);
if (!purchase.rows.length) throw new Error('Purchase not found');

const data = purchase.rows[0];
if (data.status === 'cancelled' || data.status === 'refunded') {
await client.query('COMMIT');
return { success: true, alreadyProcessed: true };
}

if (!data.provider_order_id) {
await client.query(`UPDATE purchases SET status = 'cancelled' WHERE id = $1`, [purchaseId]);
await client.query('COMMIT');
return { success: true };
}

if (data.status === 'expired') throw new Error('Cannot cancel expired rental');
await client.query('COMMIT');

let cancellation;
try {
cancellation = await fivesimCancelRental(data.provider_order_id);
} catch (error) {
await query(
`INSERT INTO reconciliation_exceptions (type, description, data) VALUES ($1,$2,$3)`,
['cancellation_failed', `Failed to cancel 5SIM order ${data.provider_order_id}`, { purchaseId, userId }]
);
throw new Error('Cancellation failed');
}

await client.query('BEGIN');
await client.query(`UPDATE purchases SET status = 'cancelled' WHERE id = $1`, [purchaseId]);

let refunded = false;
if (cancellation.refunded) {
const refundAmount = data.customer_price;
const balance = await client.query(`UPDATE users SET wallet_balance = wallet_balance + $1::NUMERIC WHERE id = $2 RETURNING wallet_balance`, [refundAmount, userId]);
const newBalance = balance.rows[0].wallet_balance;
const oldBalance = newBalance - refundAmount;

const tx = await client.query(
`INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, description, reference, metadata) VALUES ($1, 'credit', $2, $3, $4, $5, $6, $7) RETURNING id`,
[userId, refundAmount, oldBalance, newBalance, 'Refund for cancelled number', `REFUND-${purchaseId}-${Date.now()}`, { purchase_id: purchaseId }]
);

await client.query(
`INSERT INTO refunds (user_id, purchase_id, amount, reason, status, provider_refund_id, wallet_transaction_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
[userId, purchaseId, refundAmount, 'Cancellation refund', 'completed', cancellation.refundId, tx.rows[0].id]
);
refunded = true;
}

await client.query('COMMIT');
return { success: true, refunded };

} catch (error) {
await client.query('ROLLBACK');
throw error;
} finally {
client.release();
}
}

// ============================================================
// 13. PAYMENT SERVICE
// ============================================================

async function paymentInitializeTopup(userId, amount, email, name) {
if (amount < 100) throw new Error('Minimum top-up is ₦100');

const tx_ref = `DUB-${userId}-${Date.now()}-${uuidv4().substring(0, 8)}`;

await query(
`INSERT INTO payments (user_id, tx_ref, amount, currency, status, metadata) VALUES ($1,$2,$3,'NGN','pending',$4)`,
[userId, tx_ref, amount, { initiated_at: new Date().toISOString() }]
);

let payment;
try {
payment = await flwInitializePayment({
tx_ref,
amount,
email,
name,
redirect_url: `${config.backendUrl}/api/payments/callback`,
user_id: userId
});
} catch (error) {
await query(`UPDATE payments SET status = 'failed', metadata = $1 WHERE tx_ref = $2`, [{ error: error.message }, tx_ref]);
throw error;
}

await query(`UPDATE payments SET metadata = $1 WHERE tx_ref = $2`, [{ link: payment.link }, tx_ref]);
return { tx_ref, link: payment.link };
}

// ============================================================
// PAYMENT PROCESS CALLBACK - WITH DETAILED LOGGING
// ============================================================

async function paymentProcessCallback(tx_ref, transaction_id) {
console.log(`📞 [CALLBACK] Starting for tx_ref: ${tx_ref}, transaction_id: ${transaction_id}`);

const client = await getClient();

try {
console.log(`📞 [CALLBACK] Getting payment from database...`);
await client.query('BEGIN');

const payment = await client.query(`SELECT * FROM payments WHERE tx_ref = $1 FOR UPDATE`, [tx_ref]);

if (!payment.rows.length) {
console.log(`❌ [CALLBACK] Payment not found for tx_ref: ${tx_ref}`);
await client.query('COMMIT');
return { success: false, error: 'Payment not found' };
}

const paymentData = payment.rows[0];
console.log(`📞 [CALLBACK] Payment found. Status: ${paymentData.status}, Amount: ${paymentData.amount}`);

// Check if payment was cancelled
if (paymentData.status === 'cancelled') {
console.log(`ℹ️ [CALLBACK] Payment was cancelled`);
await client.query('COMMIT');
return { success: false, error: 'Payment was cancelled' };
}

if (paymentData.status === 'successful') {
console.log(`✅ [CALLBACK] Payment already processed`);
await client.query('COMMIT');
return { success: true, alreadyProcessed: true };
}

// Verify with Flutterwave
console.log(`📞 [CALLBACK] Verifying with Flutterwave API...`);
let verification;
try {
verification = await flwVerifyPayment(transaction_id);
console.log(`📞 [CALLBACK] Verification status: ${verification.status}`);
} catch (verifyError) {
console.error(`❌ [CALLBACK] Verification failed:`, verifyError.message);
await client.query('COMMIT');
return { success: false, error: 'Verification failed' };
}

const valid = verification.status === 'successful' &&
verification.tx_ref === tx_ref &&
Math.abs(parseFloat(verification.amount) - parseFloat(paymentData.amount)) < 0.01 &&
verification.currency === 'NGN';

if (!valid) {
console.log(`❌ [CALLBACK] Verification failed - invalid response`);
await client.query(
`UPDATE payments SET status = 'failed', flutterwave_transaction_id = $1 WHERE tx_ref = $2`,
[transaction_id, tx_ref]
);
await client.query('COMMIT');
return { success: false, error: 'Verification failed' };
}

console.log(`✅ [CALLBACK] Verification successful! Crediting wallet...`);

// ============================================================
// CREDIT THE WALLET
// ============================================================

// Get user's current balance
const balance = await client.query(`SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE`, [paymentData.user_id]);
if (!balance.rows.length) {
console.log(`❌ [CALLBACK] User not found: ${paymentData.user_id}`);
await client.query('COMMIT');
return { success: false, error: 'User not found' };
}
const before = parseFloat(balance.rows[0].wallet_balance);
console.log(`📞 [CALLBACK] User balance before: ${before}`);

// Add the payment amount to user's wallet
const updated = await client.query(
`UPDATE users SET wallet_balance = wallet_balance + $1::NUMERIC WHERE id = $2 RETURNING wallet_balance`,
[paymentData.amount, paymentData.user_id]
);
const after = parseFloat(updated.rows[0].wallet_balance);
console.log(`✅ [CALLBACK] User balance after: ${after}`);

// Mark payment as successful
await client.query(
`UPDATE payments SET status = 'successful', flutterwave_transaction_id = $1, processed_at = CURRENT_TIMESTAMP WHERE tx_ref = $2`,
[transaction_id, tx_ref]
);

// Record the transaction
await client.query(
`INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, description, reference, metadata) VALUES ($1, 'credit', $2, $3, $4, $5, $6, $7)`,
[paymentData.user_id, paymentData.amount, before, after, 'Wallet funding via Flutterwave', tx_ref, { payment_id: paymentData.id }]
);

await client.query('COMMIT');
console.log(`✅ [CALLBACK] Wallet credited successfully! Amount: ${paymentData.amount}, User: ${paymentData.user_id}, New balance: ${after}`);
return { success: true };

} catch (error) {
console.error(`❌ [CALLBACK] Error:`, error.message);
await client.query('ROLLBACK');
throw error;
} finally {
client.release();
}
}

async function paymentProcessWebhook(req) {
const rawBody = req.body;
const signature = req.headers['verif-hash'];

console.log(`📞 [WEBHOOK] Received webhook`);
console.log(`📞 [WEBHOOK] Signature: ${signature ? signature.substring(0, 30) + '...' : 'MISSING'}`);
console.log(`📞 [WEBHOOK] Body length: ${rawBody ? rawBody.length : 0}`);

if (!flwVerifyWebhookSignature(rawBody.toString('utf8'), signature)) {
console.log(`❌ [WEBHOOK] Invalid signature`);
throw new Error('Invalid signature');
}

console.log(`✅ [WEBHOOK] Signature verified`);

const payload = JSON.parse(rawBody.toString('utf8'));
console.log(`📞 [WEBHOOK] Payload:`, JSON.stringify(payload, null, 2));

const { tx_ref, transaction_id } = payload;

if (!tx_ref || !transaction_id) {
console.log(`❌ [WEBHOOK] Missing tx_ref or transaction_id`);
throw new Error('Invalid webhook payload');
}

console.log(`📞 [WEBHOOK] Processing: tx_ref=${tx_ref}, transaction_id=${transaction_id}`);
return paymentProcessCallback(tx_ref, transaction_id);
}

// ============================================================
// 14. RECONCILIATION
// ============================================================

async function reconciliationCheck() {
const results = { exceptions: [], summary: {} };

const pending = await query(
`SELECT * FROM purchases WHERE status = 'pending' AND created_at < NOW() - INTERVAL '10 minutes'`
);

const payments = await query(
`SELECT p.* FROM payments p LEFT JOIN wallet_transactions wt ON wt.reference = p.tx_ref WHERE p.status = 'successful' AND wt.id IS NULL AND p.created_at > NOW() - INTERVAL '24 hours'`
);

results.summary = {
pendingPurchases: pending.rows.length,
unprocessedPayments: payments.rows.length,
totalExceptions: results.exceptions.length
};

return results;
}

// ============================================================
// 15. EXPRESS
// ============================================================

const app = express();

app.use(cors({
origin: function(origin, callback) {
if (!origin) return callback(null, true);
if (config.frontendUrls.includes(origin)) return callback(null, true);
if (origin && origin.includes('netlify.app')) return callback(null, true);
if (process.env.NODE_ENV !== 'production') return callback(null, true);
callback(new Error('Not allowed by CORS'));
},
credentials: true,
methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key']
}));

app.use('/api/payments/flutterwave-webhook', express.raw({ type: 'application/json', limit: '2mb' }));
app.use(helmet());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/api', apiLimiter);

app.use((req, res, next) => {
req.requestId = uuidv4();
res.setHeader('X-Request-ID', req.requestId);
next();
});

// ============================================================
// 16. HEALTH
// ============================================================

app.get('/api/health', async (req, res) => {
try {
await query('SELECT 1');
res.json({ status: 'healthy', timestamp: new Date().toISOString(), environment: config.nodeEnv, uptime: process.uptime(), database: 'connected', provider: '5sim' });
} catch {
res.status(500).json({ status: 'unhealthy', error: 'Database connection failed' });
}
});

// ============================================================
// 17. AUTH
// ============================================================

app.get('/api/auth/me', authMiddleware, async (req, res) => {
try {
const user = await query(
`SELECT id, firebase_uid, name, email, wallet_balance, is_admin, created_at FROM users WHERE id = $1`,
[req.userId]
);
if (!user.rows.length) return res.status(404).json({ error: 'User not found' });
const u = user.rows[0];
res.json({
id: u.id,
firebaseUid: u.firebase_uid,
name: u.name,
email: u.email,
walletBalance: parseFloat(u.wallet_balance),
isAdmin: !!u.is_admin,
createdAt: u.created_at
});
} catch {
res.status(500).json({ error: 'Failed to get user' });
}
});

// ============================================================
// 18. WALLET
// ============================================================

app.get('/api/wallet', authMiddleware, async (req, res) => {
try {
const balance = await walletGetBalance(req.userId);
res.json({ balance: parseFloat(balance) });
} catch {
res.status(500).json({ error: 'Failed to get wallet' });
}
});

app.get('/api/wallet/transactions', authMiddleware, async (req, res) => {
try {
const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
const offset = Math.max(parseInt(req.query.offset) || 0, 0);
const transactions = await walletGetTransactions(req.userId, limit, offset);
res.json({ transactions, limit, offset });
} catch {
res.status(500).json({ error: 'Failed to get transactions' });
}
});

app.post('/api/wallet/topup', authMiddleware, topupLimiter, validate(schemas.topup), async (req, res) => {
try {
const { amount } = req.body;
const user = await query(`SELECT email, name FROM users WHERE id = $1`, [req.userId]);
if (!user.rows.length) return res.status(404).json({ error: 'User not found' });

const result = await paymentInitializeTopup(req.userId, amount, user.rows[0].email, user.rows[0].name);
res.json({ tx_ref: result.tx_ref, paymentLink: result.link });
} catch (error) {
if (error.message.includes('Minimum')) return res.status(400).json({ error: error.message });
res.status(500).json({ error: 'Failed to initialize payment' });
}
});

// ============================================================
// 19. COUNTRIES
// ============================================================

app.get('/api/numbers/countries', authMiddleware, servicesLimiter, async (req, res) => {
try {
const countries = Object.entries(FIVESIM_COUNTRIES).map(([code, data]) => ({
code,
name: data.displayName,
providerName: data.name,
flag: data.flag
}));
res.json(countries);
} catch {
res.status(500).json({ error: 'Failed to get countries' });
}
});

// ============================================================
// 20. SERVICES
// ============================================================

app.get('/api/numbers/services', authMiddleware, servicesLimiter, async (req, res) => {
try {
const country = req.query.country || 'US';
const services = await fivesimGetServices(country);
res.json(services);
} catch (error) {
logger.error('Get services failed', { error: error.message });
res.status(500).json({ error: 'Failed to get services' });
}
});

// ============================================================
// 21. PRICE
// ============================================================

app.get('/api/numbers/price', authMiddleware, servicesLimiter, async (req, res) => {
try {
const { service, country } = req.query;
if (!service || !country) return res.status(400).json({ error: 'Service and country required' });

const provider = await fivesimGetPrice(service, country);
const customerPrice = await calculatePriceInDb(provider.price, 'USD');

res.json({
providerCost: provider.price,
currency: 'NGN',
customerPrice: customerPrice,
service,
country,
operator: provider.operator,
stock: provider.stock,
provider: '5sim'
});
} catch (error) {
logger.error('Get price failed', { error: error.message });
res.status(500).json({ error: error.message });
}
});

// ============================================================
// 22. BUY NUMBER
// ============================================================

app.post('/api/numbers/buy', authMiddleware, purchaseLimiter, validate(schemas.buyNumber), async (req, res) => {
try {
const { service, country, period, areaCode } = req.body;
const idempotencyKey = req.headers['idempotency-key'];

if (idempotencyKey) {
try { schemas.idempotencyKey.parse(idempotencyKey); } catch {
return res.status(400).json({ error: 'Invalid idempotency key format' });
}
}

const result = await numbersBuy(req.userId, service, country, { period, areaCode, idempotencyKey });
res.json(result);
} catch (error) {
if (error.message === 'Insufficient balance') return res.status(402).json({ error: 'Insufficient wallet balance' });
if (error.message === 'Provider service unavailable') return res.status(503).json({ error: 'Service temporarily unavailable' });
res.status(500).json({ error: error.message || 'Failed to purchase number' });
}
});

// ============================================================
// 23. MY RENTALS
// ============================================================

app.get('/api/numbers/my-rentals', authMiddleware, async (req, res) => {
try {
const rentals = await numbersGetUserRentals(req.userId);
res.json(rentals);
} catch {
res.status(500).json({ error: 'Failed to get rentals' });
}
});

// ============================================================
// 24. STATUS
// ============================================================

app.get('/api/numbers/:id/status', authMiddleware, async (req, res) => {
try {
const purchase = await query(`SELECT * FROM purchases WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
if (!purchase.rows.length) return res.status(404).json({ error: 'Purchase not found' });

const data = purchase.rows[0];
if (data.provider_order_id) {
try {
const status = await fivesimGetOrder(data.provider_order_id);
const statusMap = { PENDING: 'processing', RECEIVED: 'active', FINISHED: 'active', CANCELED: 'cancelled', TIMEOUT: 'expired', BANNED: 'failed' };
const mapped = statusMap[status.status] || data.status;
if (mapped !== data.status && Object.values(PURCHASE_STATES).includes(mapped)) {
await query(`UPDATE purchases SET status = $1 WHERE id = $2`, [mapped, req.params.id]);
data.status = mapped;
}
data.number = status.phone;
data.sms = status.sms || [];
data.providerStatus = status.status;
data.expiresAt = status.expires;
} catch (error) {
logger.warn('5SIM status failed', { purchaseId: req.params.id, error: error.message });
}
}
res.json(data);
} catch {
res.status(500).json({ error: 'Failed to get rental status' });
}
});

// ============================================================
// 25. CANCEL
// ============================================================

app.post('/api/numbers/:id/cancel', authMiddleware, async (req, res) => {
try {
const result = await numbersCancel(req.userId, req.params.id);
res.json(result);
} catch (error) {
if (error.message === 'Purchase not found') return res.status(404).json({ error: 'Purchase not found' });
if (error.message === 'Cannot cancel expired rental') return res.status(400).json({ error: error.message });
res.status(500).json({ error: 'Failed to cancel rental' });
}
});

// ============================================================
// 26. MESSAGES
// ============================================================

app.get('/api/numbers/:id/messages', authMiddleware, async (req, res) => {
try {
const purchase = await query(`SELECT * FROM purchases WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
if (!purchase.rows.length) return res.status(404).json({ error: 'Purchase not found' });

const data = purchase.rows[0];
if (!data.provider_order_id) return res.json({ messages: [] });

const messages = await fivesimGetMessages(data.provider_order_id);
res.json({ messages });
} catch {
res.json({ messages: [] });
}
});

// ============================================================
// 27. FLUTTERWAVE CALLBACK - WITH CANCELLATION HANDLING
// ============================================================

app.get('/api/payments/callback', async (req, res) => {
try {
const { tx_ref, transaction_id, status, cancel } = req.query;

console.log(`🔔 [CALLBACK] Callback received:`, req.query);

// ✅ USER CANCELLED PAYMENT
if (cancel === 'true' || status === 'cancelled') {
console.log(`ℹ️ [CALLBACK] Payment cancelled by user: ${tx_ref || 'unknown'}`);
if (tx_ref) {
await query(
`UPDATE payments SET status = 'cancelled', metadata = $1 WHERE tx_ref = $2`,
[{ cancelled_at: new Date().toISOString() }, tx_ref]
);
}
return res.redirect(`${config.frontendUrls[0]}/wallet?info=Payment%20cancelled`);
}

// ❌ Missing parameters
if (!tx_ref || !transaction_id) {
console.log(`❌ [CALLBACK] Missing parameters:`, req.query);
if (tx_ref) {
const payment = await query(`SELECT status FROM payments WHERE tx_ref = $1`, [tx_ref]);
if (payment.rows.length && payment.rows[0].status === 'cancelled') {
return res.redirect(`${config.frontendUrls[0]}/wallet?info=Payment%20cancelled`);
}
}
return res.redirect(`${config.frontendUrls[0]}/wallet?error=Invalid%20callback`);
}

console.log(`✅ [CALLBACK] Processing payment: ${tx_ref}`);

try {
const result = await paymentProcessCallback(tx_ref, transaction_id);

if (result.success && !result.alreadyProcessed) {
console.log(`✅ [CALLBACK] Payment successful! Redirecting...`);
return res.redirect(`${config.frontendUrls[0]}/wallet?success=Payment%20successful`);
} else if (result.alreadyProcessed) {
console.log(`ℹ️ [CALLBACK] Payment already processed`);
return res.redirect(`${config.frontendUrls[0]}/wallet?success=Payment%20already%20processed`);
} else {
console.log(`❌ [CALLBACK] Payment failed: ${result.error}`);
return res.redirect(`${config.frontendUrls[0]}/wallet?error=${result.error || 'Payment%20failed'}`);
}
} catch (callbackError) {
console.error(`❌ [CALLBACK] Callback processing error:`, callbackError.message);
return res.redirect(`${config.frontendUrls[0]}/wallet?error=Payment%20failed`);
}

} catch (error) {
console.error(`❌ [CALLBACK] Callback error:`, error.message);
return res.redirect(`${config.frontendUrls[0]}/wallet?error=Payment%20processing%20failed`);
}
});

// ============================================================
// 28. FLUTTERWAVE WEBHOOK
// ============================================================

app.post('/api/payments/flutterwave-webhook', async (req, res) => {
try {
console.log(`🔔 [WEBHOOK] Webhook received`);

if (!req.body || req.body.length === 0) {
console.log(`❌ [WEBHOOK] Empty body`);
return res.status(400).send('Empty body');
}

const result = await paymentProcessWebhook(req);

if (result.alreadyProcessed) {
console.log(`ℹ️ [WEBHOOK] Already processed`);
return res.status(200).send('Already processed');
}

if (result.success) {
console.log(`✅ [WEBHOOK] Webhook processed successfully`);
return res.status(200).send('Webhook processed');
} else {
console.log(`❌ [WEBHOOK] Webhook processed with errors: ${result.error}`);
return res.status(200).send('Webhook processed with errors');
}
} catch (error) {
console.error(`❌ [WEBHOOK] Webhook error:`, error.message);
if (error.message === 'Invalid signature' || error.message === 'Invalid webhook payload') {
return res.status(200).send('Invalid webhook');
}
return res.status(500).send('Webhook failed');
}
});

// ============================================================
// 29. ADMIN
// ============================================================

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
try {
const result = await query(`SELECT id, name, email, wallet_balance, is_admin, is_blocked, created_at FROM users ORDER BY created_at DESC`);
res.json(result.rows);
} catch {
res.status(500).json({ error: 'Failed to get users' });
}
});

app.get('/api/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
try {
const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
const offset = Math.max(parseInt(req.query.offset) || 0, 0);
const result = await query(`SELECT * FROM wallet_transactions ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
res.json({ transactions: result.rows, limit, offset });
} catch {
res.status(500).json({ error: 'Failed to get transactions' });
}
});

app.get('/api/admin/reconciliation', authMiddleware, adminMiddleware, async (req, res) => {
try {
const results = await reconciliationCheck();
res.json(results);
} catch {
res.status(500).json({ error: 'Failed to run reconciliation' });
}
});

app.post('/api/admin/wallet-adjustment', authMiddleware, adminMiddleware, validate(schemas.adminAdjustment), async (req, res) => {
try {
const { userId, amount, direction, reason } = req.body;
const user = await query(`SELECT id FROM users WHERE id = $1`, [userId]);
if (!user.rows.length) return res.status(404).json({ error: 'User not found' });

const reference = `ADMIN-${Date.now()}-${userId}-${uuidv4().substring(0, 8)}`;

if (direction === 'credit') {
await walletCredit(userId, amount, `Admin adjustment: ${reason}`, reference, { admin_id: req.userId, reason });
} else {
await walletDebit(userId, amount, `Admin adjustment: ${reason}`, reference, { admin_id: req.userId, reason });
}

res.json({ success: true, message: `Wallet ${direction}ed successfully` });
} catch (error) {
if (error.message === 'Insufficient balance') return res.status(400).json({ error: 'Insufficient balance' });
res.status(500).json({ error: 'Failed to adjust wallet' });
}
});

// ============================================================
// 30. ERRORS
// ============================================================

app.use((req, res) => {
res.status(404).json({ error: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
logger.error('Unhandled error', { error: err.message, stack: err.stack, path: req.path, method: req.method, requestId: req.requestId });
res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
// 31. SHUTDOWN
// ============================================================

let serverInstance = null;
let shuttingDown = false;

async function gracefulShutdown() {
if (shuttingDown) return;
shuttingDown = true;
logger.info('Starting graceful shutdown');
if (serverInstance) {
await new Promise(resolve => serverInstance.close(resolve));
}
try { await pool.end(); } catch (error) { logger.error('Database shutdown error', { error: error.message }); }
process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ============================================================
// 32. START
// ============================================================

async function startServer() {
if (process.env.NODE_ENV === 'development' || process.env.RUN_MIGRATIONS === 'true') {
await runMigrations();
}

serverInstance = app.listen(config.port, () => {
logger.info(`🚀 Dub Number API running on port ${config.port}`);
logger.info(`📡 Provider: 5SIM`);
logger.info(`📊 Database: PostgreSQL`);
});

try { await reconciliationCheck(); } catch (error) { logger.error('Initial reconciliation failed', { error: error.message }); }
}

startServer().catch(error => {
logger.error('Server startup failed', { error: error.message });
process.exit(1);
});

module.exports = app;
