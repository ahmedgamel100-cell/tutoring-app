const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Optional password (set APP_PASSWORD on the server) ───────────
const APP_PASSWORD = process.env.APP_PASSWORD;
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization || '';
    const [type, encoded] = auth.split(' ');
    if (type === 'Basic' && encoded) {
      const pass = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
      if (pass === APP_PASSWORD) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="tutoring"').status(401).send('كلمة السر مطلوبة');
  });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database ─────────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || './data.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- One teacher = one sheet in the old Excel file
  CREATE TABLE IF NOT EXISTS t_teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subject TEXT DEFAULT '',
    rate_egp REAL NOT NULL DEFAULT 60,      -- default teacher price per session (EGP)
    phone TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- One group = one row in a teacher sheet
  CREATE TABLE IF NOT EXISTS t_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER NOT NULL REFERENCES t_teachers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    details TEXT DEFAULT '',                -- student names / ids (column "Date" in Excel)
    notes TEXT DEFAULT '',
    deal_qr REAL NOT NULL DEFAULT 0,        -- Deal: Student QR (package price)
    sessions_total INTEGER NOT NULL DEFAULT 0, -- All Sessions
    rate_egp REAL NOT NULL DEFAULT 60,      -- teacher price per session (EGP)
    start_date TEXT DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Money received from students (Paid To Walaa: QR / Wallet / Cash, and the cash/bank log)
  CREATE TABLE IF NOT EXISTS t_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER REFERENCES t_groups(id) ON DELETE SET NULL,
    student TEXT DEFAULT '',
    method TEXT NOT NULL CHECK (method IN ('bank','cash','wallet')), -- bank/cash in QR, wallet in EGP
    amount REAL NOT NULL,
    date TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    sender TEXT DEFAULT '',                 -- اسم المرسل
    arrived INTEGER NOT NULL DEFAULT 0,     -- الوصول
    registered INTEGER NOT NULL DEFAULT 0,  -- التسجيل
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Sessions paid to the teacher (Session 1..20 columns in Excel)
  CREATE TABLE IF NOT EXISTS t_payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES t_groups(id) ON DELETE CASCADE,
    sessions REAL NOT NULL,
    date TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

const DEFAULT_SETTINGS = { egp_per_usd: '48.25', qr_per_usd: '3.65', owner_name: 'Walaa' };
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
}

function getSettings() {
  const s = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
  const egpPerUsd = Number(s.egp_per_usd) || 48.25;
  const qrPerUsd = Number(s.qr_per_usd) || 3.65;
  return { ...s, egp_per_usd: egpPerUsd, qr_per_usd: qrPerUsd, rate: egpPerUsd / qrPerUsd }; // rate = EGP per 1 QR
}

const num = v => (v === '' || v === null || v === undefined || isNaN(Number(v))) ? 0 : Number(v);
const div = (a, b) => (b ? a / b : 0);

// ─── Calculations (same logic as the Excel sheet) ─────────────────
function computeGroup(g, payments, payouts, rate) {
  const bank = payments.filter(p => p.method === 'bank').reduce((s, p) => s + p.amount, 0);
  const cash = payments.filter(p => p.method === 'cash').reduce((s, p) => s + p.amount, 0);
  const walletEgp = payments.filter(p => p.method === 'wallet').reduce((s, p) => s + p.amount, 0);
  const walletQr = div(walletEgp, rate);
  const paidQr = bank + cash + walletQr;                    // Total in QR
  const teacherDealEgp = g.sessions_total * g.rate_egp;     // Deal: Teacher EGP
  const classPriceQr = div(g.deal_qr, g.sessions_total);    // Class price QR
  const taught = payouts.reduce((s, p) => s + p.sessions, 0); // All sessions taught by teacher
  const remaining = g.sessions_total - taught;              // The remaining sessions
  const teacherPaidEgp = taught * g.rate_egp;               // Paid to teacher (EGP)
  const earnedQr = taught * classPriceQr;                   // Value of taught sessions (QR)
  return {
    ...g,
    bank, cash, wallet_egp: walletEgp, wallet_qr: walletQr, paid_qr: paidQr,
    unpaid_qr: g.deal_qr - paidQr,
    teacher_deal_egp: teacherDealEgp,
    class_price_qr: classPriceQr,
    class_price_egp: g.rate_egp,
    taught, remaining,
    teacher_paid_egp: teacherPaidEgp,
    earned_qr: earnedQr,
    owner_net_egp: paidQr * rate - teacherPaidEgp,
  };
}

function loadGroups(where = '', params = []) {
  const { rate } = getSettings();
  const groups = db.prepare(`SELECT g.*, t.name AS teacher_name FROM t_groups g JOIN t_teachers t ON t.id = g.teacher_id ${where} ORDER BY g.archived, g.id`).all(...params);
  if (!groups.length) return [];
  const ids = groups.map(g => g.id);
  const ph = ids.map(() => '?').join(',');
  const payments = db.prepare(`SELECT * FROM t_payments WHERE group_id IN (${ph}) ORDER BY date, id`).all(...ids);
  const payouts = db.prepare(`SELECT * FROM t_payouts WHERE group_id IN (${ph}) ORDER BY date, id`).all(...ids);
  return groups.map(g => computeGroup(g,
    payments.filter(p => p.group_id === g.id),
    payouts.filter(p => p.group_id === g.id), rate));
}

function summarize(groups, rate, qrPerUsd) {
  const sum = k => groups.reduce((s, g) => s + g[k], 0);
  const paidQr = sum('paid_qr');
  const teacherPaid = sum('teacher_paid_egp');
  const paidEgp = paidQr * rate;
  const ownerNet = paidEgp - teacherPaid;
  return {
    groups: groups.length,
    deal_qr: sum('deal_qr'), bank: sum('bank'), cash: sum('cash'),
    wallet_egp: sum('wallet_egp'), wallet_qr: sum('wallet_qr'),
    paid_qr: paidQr, paid_egp: paidEgp, unpaid_qr: sum('unpaid_qr'),
    sessions_total: sum('sessions_total'), taught: sum('taught'), remaining: sum('remaining'),
    teacher_deal_egp: sum('teacher_deal_egp'),
    teacher_paid_egp: teacherPaid,
    teacher_ratio: div(teacherPaid, paidEgp),
    owner_net_egp: ownerNet,
    owner_ratio: div(ownerNet, paidEgp),
    owner_net_usd: div(div(ownerNet, rate), qrPerUsd),
    earned_qr: sum('earned_qr'),
  };
}

const wrap = fn => (req, res) => {
  try { fn(req, res); } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
};

// ─── Settings ─────────────────────────────────────────────────────
app.get('/api/settings', wrap((req, res) => res.json(getSettings())));
app.put('/api/settings', wrap((req, res) => {
  const allowed = ['egp_per_usd', 'qr_per_usd', 'owner_name'];
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const k of allowed) if (req.body[k] !== undefined && req.body[k] !== '') up.run(k, String(req.body[k]));
  res.json(getSettings());
}));

// ─── Teachers ─────────────────────────────────────────────────────
app.get('/api/teachers', wrap((req, res) => {
  const { rate, qr_per_usd } = getSettings();
  const teachers = db.prepare('SELECT * FROM t_teachers ORDER BY name').all();
  const all = loadGroups('WHERE g.archived = 0');
  res.json(teachers.map(t => ({ ...t, summary: summarize(all.filter(g => g.teacher_id === t.id), rate, qr_per_usd) })));
}));

app.get('/api/teachers/:id', wrap((req, res) => {
  const { rate, qr_per_usd } = getSettings();
  const t = db.prepare('SELECT * FROM t_teachers WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'المدرس غير موجود' });
  const groups = loadGroups('WHERE g.teacher_id = ?', [t.id]);
  res.json({ ...t, groups, summary: summarize(groups.filter(g => !g.archived), rate, qr_per_usd) });
}));

app.post('/api/teachers', wrap((req, res) => {
  const { name, subject, rate_egp, phone, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'اكتب اسم المدرس' });
  const r = db.prepare('INSERT INTO t_teachers (name, subject, rate_egp, phone, notes) VALUES (?,?,?,?,?)')
    .run(name, subject || '', num(rate_egp) || 60, phone || '', notes || '');
  res.json({ id: r.lastInsertRowid });
}));

app.put('/api/teachers/:id', wrap((req, res) => {
  const { name, subject, rate_egp, phone, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'اكتب اسم المدرس' });
  db.prepare('UPDATE t_teachers SET name=?, subject=?, rate_egp=?, phone=?, notes=? WHERE id=?')
    .run(name, subject || '', num(rate_egp) || 60, phone || '', notes || '', req.params.id);
  res.json({ ok: true });
}));

app.delete('/api/teachers/:id', wrap((req, res) => {
  db.prepare('DELETE FROM t_teachers WHERE id=?').run(req.params.id);
  res.json({ ok: true });
}));

// ─── Groups ───────────────────────────────────────────────────────
app.get('/api/groups', wrap((req, res) => res.json(loadGroups())));

app.get('/api/groups/:id', wrap((req, res) => {
  const [g] = loadGroups('WHERE g.id = ?', [req.params.id]);
  if (!g) return res.status(404).json({ error: 'المجموعة غير موجودة' });
  g.payments = db.prepare('SELECT * FROM t_payments WHERE group_id=? ORDER BY date, id').all(g.id);
  g.payouts = db.prepare('SELECT * FROM t_payouts WHERE group_id=? ORDER BY date, id').all(g.id);
  res.json(g);
}));

function groupFields(b) {
  return [b.teacher_id, b.name, b.details || '', b.notes || '', num(b.deal_qr), Math.round(num(b.sessions_total)),
    num(b.rate_egp), b.start_date || '', b.archived ? 1 : 0];
}

app.post('/api/groups', wrap((req, res) => {
  if (!req.body.teacher_id || !req.body.name) return res.status(400).json({ error: 'اختار المدرس واكتب اسم المجموعة' });
  const r = db.prepare(`INSERT INTO t_groups (teacher_id, name, details, notes, deal_qr, sessions_total, rate_egp, start_date, archived)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(...groupFields(req.body));
  res.json({ id: r.lastInsertRowid });
}));

app.put('/api/groups/:id', wrap((req, res) => {
  if (!req.body.teacher_id || !req.body.name) return res.status(400).json({ error: 'اختار المدرس واكتب اسم المجموعة' });
  db.prepare(`UPDATE t_groups SET teacher_id=?, name=?, details=?, notes=?, deal_qr=?, sessions_total=?, rate_egp=?, start_date=?, archived=? WHERE id=?`)
    .run(...groupFields(req.body), req.params.id);
  res.json({ ok: true });
}));

app.delete('/api/groups/:id', wrap((req, res) => {
  db.prepare('DELETE FROM t_groups WHERE id=?').run(req.params.id);
  res.json({ ok: true });
}));

// ─── Payments (money in) ──────────────────────────────────────────
app.get('/api/payments', wrap((req, res) => {
  const { from, to, method, q } = req.query;
  const cond = [], params = [];
  if (from) { cond.push('p.date >= ?'); params.push(from); }
  if (to) { cond.push('p.date <= ?'); params.push(to); }
  if (method) { cond.push('p.method = ?'); params.push(method); }
  if (q) { cond.push('(p.student LIKE ? OR g.name LIKE ? OR p.notes LIKE ? OR p.sender LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(`SELECT p.*, g.name AS group_name, t.name AS teacher_name
    FROM t_payments p LEFT JOIN t_groups g ON g.id = p.group_id LEFT JOIN t_teachers t ON t.id = g.teacher_id
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY p.date DESC, p.id DESC`).all(...params);
  res.json(rows);
}));

function paymentFields(b) {
  return [b.group_id || null, b.student || '', b.method, num(b.amount), b.date || '', b.notes || '', b.sender || '', b.arrived ? 1 : 0, b.registered ? 1 : 0];
}
function validPayment(b) {
  if (!['bank', 'cash', 'wallet'].includes(b.method)) return 'طريقة الدفع غير صحيحة';
  if (!num(b.amount)) return 'اكتب المبلغ';
  return null;
}

app.post('/api/payments', wrap((req, res) => {
  const err = validPayment(req.body);
  if (err) return res.status(400).json({ error: err });
  const r = db.prepare('INSERT INTO t_payments (group_id, student, method, amount, date, notes, sender, arrived, registered) VALUES (?,?,?,?,?,?,?,?,?)').run(...paymentFields(req.body));
  res.json({ id: r.lastInsertRowid });
}));

app.put('/api/payments/:id', wrap((req, res) => {
  const err = validPayment(req.body);
  if (err) return res.status(400).json({ error: err });
  db.prepare('UPDATE t_payments SET group_id=?, student=?, method=?, amount=?, date=?, notes=?, sender=?, arrived=?, registered=? WHERE id=?').run(...paymentFields(req.body), req.params.id);
  res.json({ ok: true });
}));

app.delete('/api/payments/:id', wrap((req, res) => {
  db.prepare('DELETE FROM t_payments WHERE id=?').run(req.params.id);
  res.json({ ok: true });
}));

// ─── Payouts (sessions paid to teacher) ───────────────────────────
app.post('/api/payouts', wrap((req, res) => {
  const { group_id, sessions, date, notes } = req.body;
  if (!group_id || !num(sessions)) return res.status(400).json({ error: 'اكتب عدد الحصص' });
  const r = db.prepare('INSERT INTO t_payouts (group_id, sessions, date, notes) VALUES (?,?,?,?)').run(group_id, num(sessions), date || '', notes || '');
  res.json({ id: r.lastInsertRowid });
}));

app.delete('/api/payouts/:id', wrap((req, res) => {
  db.prepare('DELETE FROM t_payouts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
}));

// ─── Dashboard ────────────────────────────────────────────────────
app.get('/api/dashboard', wrap((req, res) => {
  const s = getSettings();
  const groups = loadGroups('WHERE g.archived = 0');
  const teachers = db.prepare('SELECT * FROM t_teachers ORDER BY name').all();
  const byTeacher = teachers.map(t => ({ id: t.id, name: t.name, subject: t.subject, ...summarize(groups.filter(g => g.teacher_id === t.id), s.rate, s.qr_per_usd) }));
  const month = new Date().toISOString().slice(0, 7);
  const monthPayments = db.prepare("SELECT method, SUM(amount) AS total FROM t_payments WHERE substr(date,1,7)=? GROUP BY method").all(month);
  res.json({
    settings: s,
    totals: summarize(groups, s.rate, s.qr_per_usd),
    teachers: byTeacher,
    unpaid: groups.filter(g => g.unpaid_qr > 0.5).sort((a, b) => b.unpaid_qr - a.unpaid_qr),
    finishing: groups.filter(g => g.sessions_total > 0 && g.remaining <= 2).sort((a, b) => a.remaining - b.remaining),
    month, month_payments: monthPayments,
  });
}));

// ─── Backup / restore as JSON ─────────────────────────────────────
app.get('/api/backup', wrap((req, res) => {
  const data = {};
  for (const t of ['settings', 't_teachers', 't_groups', 't_payments', 't_payouts']) data[t] = db.prepare(`SELECT * FROM ${t}`).all();
  res.set('Content-Disposition', `attachment; filename="backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
}));

// ─── Export to Excel ──────────────────────────────────────────────
app.get('/api/export', async (req, res) => {
  try {
    const s = getSettings();
    const wb = new ExcelJS.Workbook();
    const groups = loadGroups();
    const teachers = db.prepare('SELECT * FROM t_teachers ORDER BY name').all();
    const used = new Set();
    for (const t of teachers) {
      let name = t.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Teacher';
      while (used.has(name)) name += '_';
      used.add(name);
      const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true }] });
      ws.addRow([`${t.subject} ${t.name}`]);
      ws.addRow(['المجموعة', 'الطلاب', 'ملاحظات', 'سعر الباقة QR', 'عدد الحصص', 'سعر الحصة QR', 'سعر حصة المدرس EGP',
        'بنك QR', 'كاش QR', 'محفظة EGP', 'إجمالي المدفوع QR', 'المتبقي على الطالب QR', 'حصص اتدفعت للمدرس', 'الحصص المتبقية', 'اتدفع للمدرس EGP', 'الصافي EGP']);
      for (const g of groups.filter(g => g.teacher_id === t.id)) {
        ws.addRow([g.name, g.details, g.notes, g.deal_qr, g.sessions_total, g.class_price_qr, g.rate_egp, g.bank, g.cash, g.wallet_egp,
          g.paid_qr, g.unpaid_qr, g.taught, g.remaining, g.teacher_paid_egp, g.owner_net_egp]);
      }
      ws.getRow(2).font = { bold: true };
      ws.columns.forEach(c => { c.width = 16; });
    }
    const ps = wb.addWorksheet('المدفوعات', { views: [{ rightToLeft: true }] });
    ps.addRow(['التاريخ', 'الطالب', 'المجموعة', 'المدرس', 'الطريقة', 'المبلغ', 'ملاحظات']);
    const methods = { bank: 'بنك (QR)', cash: 'كاش (QR)', wallet: 'محفظة (EGP)' };
    for (const p of db.prepare(`SELECT p.*, g.name AS group_name, t.name AS teacher_name FROM t_payments p LEFT JOIN t_groups g ON g.id=p.group_id LEFT JOIN t_teachers t ON t.id=g.teacher_id ORDER BY p.date`).all()) {
      ps.addRow([p.date, p.student, p.group_name || '', p.teacher_name || '', methods[p.method], p.amount, p.notes]);
    }
    ps.getRow(1).font = { bold: true };
    ps.columns.forEach(c => { c.width = 18; });
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="tutoring-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ─── Import from the old Excel file ───────────────────────────────
const cellVal = c => {
  const v = c && c.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (v instanceof Date) return v;
    if ('result' in v) return v.result ?? null;
    if ('formula' in v || 'sharedFormula' in v) return null;
    if (v.richText) return v.richText.map(r => r.text).join('');
    if ('text' in v) return v.text;
    return null;
  }
  return v;
};
const formulaOf = c => (c && c.value && typeof c.value === 'object' && (c.value.formula || c.value.sharedFormula)) || null;

// Dates in the log are typed like 17524 (= 17-5-24) or 1624 (= 1-6-24).
function parseCompactDate(v, range) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const digits = String(v ?? '').replace(/\D/g, '');
  if (digits.length < 3 || digits.length > 6) return '';
  const yy = digits.length >= 4 ? digits.slice(-2) : null;
  const dm = yy ? digits.slice(0, -2) : digits;
  const year = yy ? 2000 + Number(yy) : null;
  const candidates = [];
  for (let i = 1; i < dm.length; i++) {
    const d = Number(dm.slice(0, i)), m = Number(dm.slice(i));
    if (dm.slice(i).startsWith('0') && dm.slice(i).length === 1) continue;
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && year) candidates.push(`${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  if (!candidates.length) return '';
  if (range) {
    const inRange = candidates.find(c => c >= range[0] && c <= range[1]);
    if (inRange) return inRange;
    return '';
  }
  return candidates[0];
}

function parseRangeHeader(text) {
  const m = String(text).match(/(\d{1,2})-(\d{1,2})-(\d{1,2})\D+(\d{1,2})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const iso = (y, mo, d) => {
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
    return `20${String(y).padStart(2, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  const shift = (s, days) => { const d = new Date(s); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
  // try day-month-year first (e.g. 15-5-24), then year-month-day (e.g. 23-11-10)
  for (const [a, b] of [[iso(m[3], m[2], m[1]), iso(m[6], m[5], m[4])], [iso(m[1], m[2], m[3]), iso(m[4], m[5], m[6])]]) {
    if (a && b && a < b && a >= '2020-01-01') return [shift(a, -15), shift(b, 15)];
  }
  return null;
}

function importWorkbook(wb) {
  const stats = { teachers: 0, groups: 0, payments: 0, payouts: 0, log_payments: 0, skipped_sheets: [] };
  const insTeacher = db.prepare('INSERT INTO t_teachers (name, subject, rate_egp, notes) VALUES (?,?,?,?)');
  const insGroup = db.prepare('INSERT INTO t_groups (teacher_id, name, details, notes, deal_qr, sessions_total, rate_egp) VALUES (?,?,?,?,?,?,?)');
  const insPay = db.prepare('INSERT INTO t_payments (group_id, student, method, amount, date, notes, sender, arrived, registered) VALUES (?,?,?,?,?,?,?,?,?)');
  const insPayout = db.prepare('INSERT INTO t_payouts (group_id, sessions, date, notes) VALUES (?,?,?,?)');

  const run = db.transaction(() => {
    wb.eachSheet(ws => {
      const title = ws.name.trim();
      // ── Teacher sheets: header "Group Name" in C2 ──
      const isTeacher = String(cellVal(ws.getCell('C2')) || '').trim() === 'Group Name';
      if (isTeacher) {
        if (/^blank/i.test(title)) { stats.skipped_sheets.push(title + ' (نموذج فاضي)'); return; }
        const rows = [];
        for (let r = 5; r <= ws.rowCount; r++) {
          const label = String(cellVal(ws.getCell(r, 3)) || '').trim();
          if (/^subtotal$/i.test(label)) break;
          const name = label;
          const deal = num(cellVal(ws.getCell(r, 11)));
          const total = num(cellVal(ws.getCell(r, 13)));
          const paidBank = num(cellVal(ws.getCell(r, 4)));
          const wallet = num(cellVal(ws.getCell(r, 5)));
          const cash = num(cellVal(ws.getCell(r, 7)));
          if (!name && !deal && !total && !paidBank && !wallet && !cash) continue;
          const lf = formulaOf(ws.getCell(r, 12)) || '';
          const mult = lf.match(/\*\s*([\d.]+)/);
          const lVal = num(cellVal(ws.getCell(r, 12)));
          const rate = mult ? Number(mult[1]) : (total ? lVal / total : 60);
          const sessions = [];
          for (let c = 15; c <= 53; c += 2) {
            const v = num(cellVal(ws.getCell(r, c)));
            if (v) sessions.push({ n: (c - 13) / 2, v });
          }
          rows.push({ r, name: name || `مجموعة ${r - 4}`, deal, total, paidBank, wallet, cash, rate,
            details: String(cellVal(ws.getCell(r, 8)) || ''), notes: String(cellVal(ws.getCell(r, 1)) || ''), sessions });
        }
        const head = String(cellVal(ws.getCell('A1')) || '').trim();
        const hm = head.match(/^(\S+)\s+(.+)$/);
        const subject = hm ? hm[1] : '';
        const tName = hm ? hm[2] : (head || title);
        const tRate = rows.length ? rows[0].rate : 60;
        const tId = insTeacher.run(tName, subject, tRate, `مستورد من شيت ${title}`).lastInsertRowid;
        stats.teachers++;
        for (const g of rows) {
          const gid = insGroup.run(tId, g.name, g.details, g.notes, g.deal, Math.round(g.total), g.rate).lastInsertRowid;
          stats.groups++;
          const note = 'مستورد من Excel';
          if (g.paidBank) { insPay.run(gid, g.name, 'bank', g.paidBank, '', note, '', 1, 1); stats.payments++; }
          if (g.wallet) { insPay.run(gid, g.name, 'wallet', g.wallet, '', note, '', 1, 1); stats.payments++; }
          if (g.cash) { insPay.run(gid, g.name, 'cash', g.cash, '', note, '', 1, 1); stats.payments++; }
          for (const s of g.sessions) { insPayout.run(gid, s.v, '', `دفعة رقم ${s.n} (مستورد)`); stats.payouts++; }
        }
        return;
      }
      // ── Payment log sheets: header row with "كاش" / "بنك" / "اسم الطالب" ──
      let found = false, range = null, period = '', cols = {};
      ws.eachRow((row, r) => {
        const b = cellVal(row.getCell(2)), c = cellVal(row.getCell(3)), d = cellVal(row.getCell(4)), e = cellVal(row.getCell(5));
        const bs = String(b ?? '').trim();
        if (/\d{1,2}-\d{1,2}-\d{1,2}/.test(bs) && typeof c !== 'number') { range = parseRangeHeader(bs); period = bs; return; }
        if (bs === 'كاش' && String(c ?? '').trim() === 'بنك') {
          found = true; cols = {};
          for (let i = 6; i <= 10; i++) {
            const h = String(cellVal(row.getCell(i)) ?? '').trim();
            if (h === 'اسم المرسل') cols.sender = i;
            else if (h === 'الوصول') cols.arrived = i;
            else if (h === 'التسجيل') cols.registered = i;
          }
          return;
        }
        if (!found || formulaOf(row.getCell(2)) || formulaOf(row.getCell(3))) return;
        const student = typeof d === 'string' ? d.trim() : '';
        if (!student || /^(walaa|total)/i.test(student)) return;
        const date = parseCompactDate(e, range);
        const txt = i => (i ? String(cellVal(row.getCell(i)) ?? '').trim() : '');
        const sender = txt(cols.sender);
        const arrivedTxt = txt(cols.arrived), registeredTxt = txt(cols.registered);
        const arrived = /^(yes|وصل)/i.test(arrivedTxt) ? 1 : 0;
        const registered = /^(done|اتسجل|yes)/i.test(registeredTxt) ? 1 : 0;
        const extra = [period,
          date ? '' : (e ? `التاريخ الأصلي: ${e}` : ''),
          arrivedTxt && !/^(yes|وصل)$/i.test(arrivedTxt) ? arrivedTxt : ''].filter(Boolean).join(' | ');
        for (const [amt, method] of [[b, 'cash'], [c, 'bank']]) {
          if (num(amt)) { insPay.run(null, student, method, num(amt), date, extra, sender, arrived, registered); stats.log_payments++; }
        }
      });
      if (!found) stats.skipped_sheets.push(title);
    });
  });
  run();
  return stats;
}

app.post('/api/import', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'اختار ملف Excel' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.body);
    if (req.query.replace === '1') {
      db.exec('DELETE FROM t_payouts; DELETE FROM t_payments; DELETE FROM t_groups; DELETE FROM t_teachers;');
    }
    res.json(importWorkbook(wb));
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'مقدرتش أقرا الملف: ' + e.message });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
}

module.exports = { app, db, importWorkbook, parseCompactDate };
