const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database setup
const db = new Database(process.env.DB_PATH || './tutoring.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    price REAL NOT NULL,
    phone TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    grade TEXT NOT NULL,
    teacher_id INTEGER,
    price REAL NOT NULL,
    parent TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (teacher_id) REFERENCES teachers(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    student_id INTEGER NOT NULL,
    teacher_id INTEGER NOT NULL,
    count INTEGER NOT NULL,
    student_price REAL NOT NULL,
    teacher_price REAL NOT NULL,
    rate_snapshot REAL NOT NULL,
    paid_by_student INTEGER DEFAULT 0,
    paid_to_teacher INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (student_id) REFERENCES students(id),
    FOREIGN KEY (teacher_id) REFERENCES teachers(id)
  );

  CREATE TABLE IF NOT EXISTS exchange_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rate REAL NOT NULL,
    date TEXT NOT NULL,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed default rate if empty
const rateCount = db.prepare('SELECT COUNT(*) as c FROM exchange_rates').get();
if (rateCount.c === 0) {
  db.prepare('INSERT INTO exchange_rates (rate, date, note) VALUES (?, ?, ?)').run(13.7, '2025-01-01', 'سعر البداية');
}

// ─── HELPERS ─────────────────────────────────────────────
function getCurrentRate(forMonth) {
  const rates = db.prepare('SELECT * FROM exchange_rates WHERE date <= ? ORDER BY date DESC LIMIT 1').get(forMonth + '-31');
  if (rates) return rates.rate;
  return db.prepare('SELECT rate FROM exchange_rates ORDER BY date ASC LIMIT 1').get().rate;
}

// ─── TEACHERS ─────────────────────────────────────────────
app.get('/api/teachers', (req, res) => {
  const teachers = db.prepare('SELECT * FROM teachers ORDER BY name').all();
  res.json(teachers);
});

app.post('/api/teachers', (req, res) => {
  const { name, subject, price, phone } = req.body;
  if (!name || !subject || !price) return res.status(400).json({ error: 'بيانات ناقصة' });
  const result = db.prepare('INSERT INTO teachers (name, subject, price, phone) VALUES (?, ?, ?, ?)').run(name, subject, price, phone || '');
  res.json({ id: result.lastInsertRowid, name, subject, price, phone });
});

app.put('/api/teachers/:id', (req, res) => {
  const { name, subject, price, phone } = req.body;
  db.prepare('UPDATE teachers SET name=?, subject=?, price=?, phone=? WHERE id=?').run(name, subject, price, phone, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/teachers/:id', (req, res) => {
  db.prepare('UPDATE students SET teacher_id=NULL WHERE teacher_id=?').run(req.params.id);
  db.prepare('DELETE FROM teachers WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── STUDENTS ─────────────────────────────────────────────
app.get('/api/students', (req, res) => {
  const students = db.prepare(`
    SELECT s.*, t.name as teacher_name, t.subject as teacher_subject
    FROM students s
    LEFT JOIN teachers t ON s.teacher_id = t.id
    ORDER BY s.name
  `).all();
  res.json(students);
});

app.post('/api/students', (req, res) => {
  const { name, grade, teacher_id, price, parent } = req.body;
  if (!name || !grade || !price) return res.status(400).json({ error: 'بيانات ناقصة' });
  const result = db.prepare('INSERT INTO students (name, grade, teacher_id, price, parent) VALUES (?, ?, ?, ?, ?)').run(name, grade, teacher_id || null, price, parent || '');
  res.json({ id: result.lastInsertRowid, name, grade, teacher_id, price });
});

app.put('/api/students/:id', (req, res) => {
  const { name, grade, teacher_id, price, parent } = req.body;
  db.prepare('UPDATE students SET name=?, grade=?, teacher_id=?, price=?, parent=? WHERE id=?').run(name, grade, teacher_id, price, parent, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/students/:id', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE student_id=?').run(req.params.id);
  db.prepare('DELETE FROM students WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── SESSIONS ─────────────────────────────────────────────
app.get('/api/sessions', (req, res) => {
  const { month } = req.query;
  let query = `
    SELECT se.*,
      st.name as student_name,
      t.name as teacher_name
    FROM sessions se
    LEFT JOIN students st ON se.student_id = st.id
    LEFT JOIN teachers t ON se.teacher_id = t.id
  `;
  const sessions = month
    ? db.prepare(query + ' WHERE se.month=? ORDER BY st.name').all(month)
    : db.prepare(query + ' ORDER BY se.month DESC, st.name').all();
  res.json(sessions);
});

app.get('/api/sessions/months', (req, res) => {
  const months = db.prepare('SELECT DISTINCT month FROM sessions ORDER BY month DESC').all();
  res.json(months.map(r => r.month));
});

app.post('/api/sessions', (req, res) => {
  const { month, student_id, teacher_id, count } = req.body;
  if (!month || !student_id || !teacher_id || !count) return res.status(400).json({ error: 'بيانات ناقصة' });
  const student = db.prepare('SELECT price FROM students WHERE id=?').get(student_id);
  const teacher = db.prepare('SELECT price FROM teachers WHERE id=?').get(teacher_id);
  if (!student || !teacher) return res.status(404).json({ error: 'الطالب أو المدرس غير موجود' });
  const rate = getCurrentRate(month);
  // Check if session exists for this student+month
  const existing = db.prepare('SELECT id FROM sessions WHERE month=? AND student_id=?').get(month, student_id);
  if (existing) {
    db.prepare('UPDATE sessions SET teacher_id=?, count=?, student_price=?, teacher_price=?, rate_snapshot=? WHERE id=?')
      .run(teacher_id, count, student.price, teacher.price, rate, existing.id);
    res.json({ id: existing.id, updated: true });
  } else {
    const result = db.prepare('INSERT INTO sessions (month, student_id, teacher_id, count, student_price, teacher_price, rate_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(month, student_id, teacher_id, count, student.price, teacher.price, rate);
    res.json({ id: result.lastInsertRowid });
  }
});

app.patch('/api/sessions/:id/payment', (req, res) => {
  const { field } = req.body; // 'paid_by_student' or 'paid_to_teacher'
  const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const col = field === 'student' ? 'paid_by_student' : 'paid_to_teacher';
  const newVal = session[col] ? 0 : 1;
  db.prepare(`UPDATE sessions SET ${col}=? WHERE id=?`).run(newVal, req.params.id);
  res.json({ [col]: newVal });
});

app.delete('/api/sessions/:id', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── EXCHANGE RATES ────────────────────────────────────────
app.get('/api/rates', (req, res) => {
  const rates = db.prepare('SELECT * FROM exchange_rates ORDER BY date DESC').all();
  res.json(rates);
});

app.post('/api/rates', (req, res) => {
  const { rate, date, note } = req.body;
  if (!rate || !date) return res.status(400).json({ error: 'بيانات ناقصة' });
  const result = db.prepare('INSERT INTO exchange_rates (rate, date, note) VALUES (?, ?, ?)').run(rate, date, note || '');
  res.json({ id: result.lastInsertRowid, rate, date, note });
});

app.delete('/api/rates/:id', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM exchange_rates').get();
  if (count.c <= 1) return res.status(400).json({ error: 'لا يمكن حذف السعر الوحيد' });
  db.prepare('DELETE FROM exchange_rates WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── DASHBOARD ────────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const rate = getCurrentRate(month);
  const teachers = db.prepare('SELECT COUNT(*) as c FROM teachers').get().c;
  const students = db.prepare('SELECT COUNT(*) as c FROM students').get().c;
  const sessions = db.prepare('SELECT COALESCE(SUM(count),0) as c FROM sessions WHERE month=?').get(month).c;
  const financials = db.prepare(`
    SELECT
      COALESCE(SUM(student_price * count), 0) as total_qar,
      COALESCE(SUM(CASE WHEN paid_by_student=1 THEN student_price * count ELSE 0 END), 0) as collected_qar,
      COALESCE(SUM(teacher_price * count), 0) as total_egp,
      COALESCE(SUM(CASE WHEN paid_to_teacher=1 THEN teacher_price * count ELSE 0 END), 0) as paid_egp
    FROM sessions WHERE month=?
  `).get(month);
  res.json({ month, rate, teachers, students, sessions, ...financials });
});

// Fallback to index.html
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
