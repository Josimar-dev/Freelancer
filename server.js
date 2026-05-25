require('dotenv').config();
const express = require('express');
const cors = require('cors');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'database.sqlite');
const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

let transporter = null;
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch {}
if (process.env.SMTP_HOST && nodemailer) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}
const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let db;

async function start() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cliente',
      whatsapp TEXT DEFAULT '',
      createdAt TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS reset_tokens (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      token TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      used INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      budget REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      clientId INTEGER NOT NULL,
      clientName TEXT NOT NULL,
      professionalId INTEGER,
      professionalName TEXT,
      createdAt TEXT DEFAULT (datetime('now'))
    )
  `);

  saveDb();
  console.log('Banco SQLite inicializado.');

  if (transporter) {
    transporter.verify().then(() => {
      console.log('✅ SMTP configurado e funcionando.');
    }).catch(err => {
      console.error('❌ SMTP configurado mas conexão falhou:', err.message);
    });
  } else if (process.env.SMTP_HOST) {
    console.error('❌ SMTP_HOST definido mas nodemailer não foi carregado.');
  } else {
    console.log('ℹ️  SMTP não configurado. E-mails serão apenas logados.');
  }
}

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (stored.startsWith('scrypt:')) {
    const parts = stored.split(':');
    const salt = parts[1];
    const hash = parts[2];
    const computedHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return hash === computedHash;
  }
  return stored === password;
}

// ======================== USERS ========================

app.get('/api/users', (req, res) => {
  const users = db.exec('SELECT id, name, email, role, whatsapp, createdAt FROM users ORDER BY id DESC');
  if (!users.length) return res.json([]);
  const rows = users[0].values.map(v => ({
    id: v[0], name: v[1], email: v[2], role: v[3], whatsapp: v[4], createdAt: v[5]
  }));
  res.json(rows);
});

app.post('/api/register', (req, res) => {
  const { name, email, password, role, whatsapp } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Preencha todos os campos.' });
  }

  const existing = db.exec(`SELECT id FROM users WHERE email = '${email.replace(/'/g, "''")}'`);
  if (existing.length && existing[0].values.length) {
    return res.status(400).json({ error: 'Email já cadastrado.' });
  }

  const id = Date.now();
  const safeName = name.replace(/'/g, "''");
  const hashedPass = hashPassword(password);
  const safeHashedPass = hashedPass.replace(/'/g, "''");
  const safeEmail = email.replace(/'/g, "''");
  const safeWpp = (whatsapp || '').replace(/'/g, "''");

  db.run(`INSERT INTO users (id, name, email, password, role, whatsapp) VALUES (${id}, '${safeName}', '${safeEmail}', '${safeHashedPass}', '${role}', '${safeWpp}')`);
  saveDb();

  res.json({ id, name, email, role, whatsapp });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Preencha email e senha.' });

  // Admin
  if (email === 'admin@admin.com' && password === 'Jo88211509*') {
    return res.json({ id: 0, name: 'Administrador', email, role: 'admin', whatsapp: '' });
  }

  const result = db.exec(`SELECT id, name, email, password, role, whatsapp FROM users WHERE email = '${email.replace(/'/g, "''")}'`);
  if (!result.length || !result[0].values.length) {
    return res.status(401).json({ error: 'Email ou senha incorretos.' });
  }

  const row = result[0].values[0];
  if (!verifyPassword(password, row[3])) {
    return res.status(401).json({ error: 'Email ou senha incorretos.' });
  }

  res.json({ id: row[0], name: row[1], email: row[2], role: row[4], whatsapp: row[5] });
});

// ======================== PASSWORD RESET ========================

function sendEmail(to, subject, html) {
  if (!transporter) {
    console.log(`[EMAIL] To: ${to}`);
    console.log(`[EMAIL] Subject: ${subject}`);
    console.log(`[EMAIL] Body: ${html}`);
    return Promise.reject(new Error('SMTP não configurado.'));
  }
  return transporter.sendMail({
    from: process.env.SMTP_FROM || `"BR Service" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html
  });
}

app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Informe seu email.' });

  const user = db.exec(`SELECT id, name FROM users WHERE email = '${email.replace(/'/g, "''")}'`);
  if (!user.length || !user[0].values.length) {
    return res.json({ message: 'Se o email existir, você receberá um link de recuperação.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 3600000).toISOString().replace('T', ' ').replace(/\..+/, '');
  const safeToken = token.replace(/'/g, "''");
  const safeEmail = email.replace(/'/g, "''");

  db.run(`INSERT INTO reset_tokens (email, token, expiresAt) VALUES ('${safeEmail}', '${safeToken}', '${expiresAt}')`);
  saveDb();

  const resetLink = `${APP_URL}/?reset-token=${token}`;
  const userName = user[0].values[0][1];

  try {
    await sendEmail(
      email,
      'BR Service - Recuperação de Senha',
      `<p>Olá <strong>${userName}</strong>,</p>
<p>Recebemos uma solicitação de recuperação de senha para sua conta no BR Service.</p>
<p><a href="${resetLink}" style="display:inline-block;padding:12px 24px;background:#38bdf8;color:#0f172a;text-decoration:none;border-radius:8px;font-weight:bold;">Redefinir Senha</a></p>
<p>Ou copie o link: <br>${resetLink}</p>
<p>Este link expira em 1 hora.</p>
<p>Se você não solicitou esta recuperação, ignore este email.</p>`
    );
  } catch (err) {
    console.error('Erro ao enviar email:', err);
    return res.status(500).json({ error: 'Erro ao enviar email de recuperação. Verifique a configuração SMTP.' });
  }

  res.json({ message: 'Se o email existir, você receberá um link de recuperação.' });
});

app.post('/api/reset-password', (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token e nova senha são obrigatórios.' });
  if (password.length < 4) return res.status(400).json({ error: 'A senha deve ter pelo menos 4 caracteres.' });

  const safeToken = token.replace(/'/g, "''");
  const result = db.exec(`SELECT email FROM reset_tokens WHERE token = '${safeToken}' AND used = 0 AND expiresAt > datetime('now')`);

  if (!result.length || !result[0].values.length) {
    return res.status(400).json({ error: 'Token inválido ou expirado.' });
  }

  const email = result[0].values[0][0];
  const hashedPass = hashPassword(password);
  const safeHashedPass = hashedPass.replace(/'/g, "''");
  const safeEmail = email.replace(/'/g, "''");

  db.run(`UPDATE users SET password = '${safeHashedPass}' WHERE email = '${safeEmail}'`);
  db.run(`UPDATE reset_tokens SET used = 1 WHERE token = '${safeToken}'`);
  saveDb();

  res.json({ message: 'Senha redefinida com sucesso! Faça login.' });
});

// ======================== TASKS ========================

app.get('/api/tasks', (req, res) => {
  const result = db.exec('SELECT id, title, description, budget, status, clientId, clientName, professionalId, professionalName, createdAt FROM tasks ORDER BY id DESC');
  if (!result.length) return res.json([]);
  const rows = result[0].values.map(v => ({
    id: v[0], title: v[1], description: v[2], budget: v[3],
    status: v[4], clientId: v[5], clientName: v[6],
    professionalId: v[7], professionalName: v[8], createdAt: v[9]
  }));
  res.json(rows);
});

app.post('/api/tasks', (req, res) => {
  const { title, description, budget, clientId, clientName } = req.body;
  if (!title || !description || !budget || !clientId) {
    return res.status(400).json({ error: 'Preencha todos os campos.' });
  }

  const id = Date.now();
  const safeTitle = title.replace(/'/g, "''");
  const safeDesc = description.replace(/'/g, "''");
  const safeName = clientName.replace(/'/g, "''");

  db.run(`INSERT INTO tasks (id, title, description, budget, status, clientId, clientName) VALUES (${id}, '${safeTitle}', '${safeDesc}', ${budget}, 'open', ${clientId}, '${safeName}')`);
  saveDb();

  res.json({ id, title, description, budget, status: 'open', clientId, clientName, professionalId: null, professionalName: null });
});

app.put('/api/tasks/:id/accept', (req, res) => {
  const { id } = req.params;
  const { professionalId, professionalName } = req.body;

  const result = db.exec(`SELECT status FROM tasks WHERE id = ${parseInt(id)}`);
  if (!result.length || !result[0].values.length) {
    return res.status(404).json({ error: 'Tarefa não encontrada.' });
  }
  if (result[0].values[0][0] !== 'open') {
    return res.status(400).json({ error: 'Tarefa já foi aceita.' });
  }

  const safeName = professionalName.replace(/'/g, "''");
  db.run(`UPDATE tasks SET status = 'in_progress', professionalId = ${professionalId}, professionalName = '${safeName}' WHERE id = ${parseInt(id)}`);
  saveDb();

  res.json({ success: true });
});

app.put('/api/tasks/:id/complete', (req, res) => {
  const { id } = req.params;
  const { clientId } = req.body;

  const result = db.exec(`SELECT clientId, status, title FROM tasks WHERE id = ${parseInt(id)}`);
  if (!result.length || !result[0].values.length) {
    return res.status(404).json({ error: 'Tarefa não encontrada.' });
  }

  const row = result[0].values[0];
  if (row[0] !== clientId) return res.status(403).json({ error: 'Apenas o cliente pode concluir.' });
  if (row[1] !== 'in_progress') return res.status(400).json({ error: 'Tarefa não está em andamento.' });
  const taskTitle = row[2];

  db.run(`UPDATE tasks SET status = 'completed' WHERE id = ${parseInt(id)}`);
  saveDb();

  // Notify support
  const userResult = db.exec(`SELECT name, whatsapp FROM users WHERE id = ${parseInt(clientId)}`);
  let clientName = clientId;
  let clientWpp = 'não informado';
  if (userResult.length && userResult[0].values.length) {
    clientName = userResult[0].values[0][0];
    clientWpp = userResult[0].values[0][1] || 'não informado';
  }

  const supportEmail = process.env.SUPPORT_EMAIL || process.env.SMTP_USER || 'suporte@brservice.com';
  sendEmail(
    supportEmail,
    'BR Service - Atividade Concluída',
    `<p><strong>Atividade concluída!</strong></p>
<p><strong>Cliente:</strong> ${clientName}</p>
<p><strong>WhatsApp:</strong> ${clientWpp}</p>
<p><strong>Tarefa:</strong> ${taskTitle}</p>`
  ).catch(err => console.error('Erro ao notificar suporte:', err));

  res.json({ success: true });
});

// ======================== SPA CATCH-ALL ========================
// Serve index.html for any unmatched route (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ======================== START ========================
start()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`Servidor rodando em http://${HOST}:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Erro ao iniciar:', err);
    process.exit(1);
  });
