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
    },
    logger: true,
    debug: true
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
      lastOnboardingReminder TEXT,
      onboardingReminderCount INTEGER DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY,
      taskId INTEGER NOT NULL,
      senderId INTEGER NOT NULL,
      senderName TEXT NOT NULL,
      senderRole TEXT NOT NULL,
      message TEXT NOT NULL,
      createdAt TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY,
      userId INTEGER NOT NULL,
      senderId INTEGER NOT NULL,
      senderName TEXT NOT NULL,
      senderRole TEXT NOT NULL,
      message TEXT NOT NULL,
      createdAt TEXT DEFAULT (datetime('now'))
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

  db.run(`
    CREATE TABLE IF NOT EXISTS onboarding (
      userId INTEGER PRIMARY KEY,
      bio TEXT DEFAULT '',
      skills TEXT DEFAULT '',
      portfolio TEXT DEFAULT '',
      linkedin TEXT DEFAULT '',
      availability TEXT DEFAULT '',
      experience TEXT DEFAULT '',
      categories TEXT DEFAULT '',
      hourlyRate REAL DEFAULT 0,
      photo TEXT DEFAULT '',
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

function safeSql(value) {
  return String(value ?? '').replace(/'/g, "''");
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
    console.log(`[EMAIL SIMULADO] To: ${to}`);
    console.log(`[EMAIL SIMULADO] Subject: ${subject}`);
    console.log(`[EMAIL SIMULADO] Body: ${html}`);
    return Promise.resolve({ simulated: true });
  }
  const from = process.env.SMTP_FROM || `"BR Service" <${process.env.SMTP_USER}>`;
  console.log(`[SMTP] Enviando email para ${to} de ${from}...`);
  return transporter.sendMail({ from, to, subject, html });
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

  function emailTemplate(body) {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
        <tr><td style="padding:0 0 28px;text-align:center">
          <table cellpadding="0" cellspacing="0" style="display:inline-block">
            <tr><td style="background:#0b1220;padding:10px 22px;border-radius:10px">
              <span style="color:#38bdf8;font-size:20px;font-weight:800;letter-spacing:1.5px">BR</span>
              <span style="color:#fff;font-size:20px;font-weight:300;letter-spacing:2px">SERVICE</span>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.08)">
          <table cellpadding="0" cellspacing="0" width="100%">
            <tr><td style="background:linear-gradient(145deg,#0b1220 0%,#162044 50%,#0b1220 100%);padding:40px 36px 28px;text-align:center;position:relative">
              <div style="position:absolute;top:0;left:0;right:0;bottom:0;opacity:0.08;background-image:radial-gradient(circle at 20% 40%,#38bdf8 0%,transparent 60%),radial-gradient(circle at 80% 60%,#22d3ee 0%,transparent 50%)"></div>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 16px">
                <tr><td style="width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#38bdf8,#22d3ee);text-align:center;vertical-align:middle;font-size:26px;line-height:60px;box-shadow:0 8px 24px rgba(56,189,248,0.35)">🔐</td></tr>
              </table>
              <h1 style="color:#ffffff;font-size:24px;font-weight:700;margin:0;letter-spacing:-0.3px">Recupera\u00e7\u00e3o de senha</h1>
              <p style="color:rgba(255,255,255,0.7);font-size:14px;margin:8px 0 0;line-height:1.5">Clique no bot\u00e3o abaixo para redefinir sua senha</p>
            </td></tr>
            <tr><td style="padding:36px 36px 16px">
              ${body}
            </td></tr>
            <tr><td style="padding:24px 36px;border-top:1px solid #eef0f4;text-align:center">
              <p style="font-size:12px;color:#999;margin:0 0 4px;line-height:1.6">Este link expira em <strong>1 hora</strong> por seguran\u00e7a.</p>
              <p style="font-size:12px;color:#bbb;margin:0;line-height:1.6">Se voc\u00ea n\u00e3o solicitou esta redefini\u00e7\u00e3o, desconsidere este email.</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:20px 16px 0;text-align:center">
          <p style="font-size:11px;color:#aaa;margin:0 0 4px;line-height:1.5">BR Service — Plataforma de tarefas de programa\u00e7\u00e3o</p>
          <p style="font-size:11px;color:#ccc;margin:0">© 2026 BR Service. Todos os direitos reservados.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }

  const emailHtml = emailTemplate(`
    <p style="font-size:16px;color:#1a1a2e;margin:0 0 18px">Ol\u00e1 <strong style="color:#0b1220">${userName}</strong>,</p>
    <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 24px">Recebemos uma solicita\u00e7\u00e3o de redefini\u00e7\u00e3o de senha para sua conta. Para criar uma nova senha, clique no bot\u00e3o abaixo:</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px">
      <tr><td align="center" style="background:linear-gradient(135deg,#38bdf8,#22d3ee);border-radius:12px;box-shadow:0 8px 24px rgba(56,189,248,0.35)">
        <a href="${resetLink}" style="display:inline-block;padding:15px 48px;font-size:15px;font-weight:700;color:#0b1220;text-decoration:none;letter-spacing:0.5px;border-radius:12px">REDEFINIR SENHA</a>
      </td></tr>
    </table>
    <table cellpadding="16" cellspacing="0" style="background:#f7f8fa;border-radius:12px;margin:0 0 8px;width:100%">
      <tr><td style="font-size:13px;color:#666;line-height:1.6;padding:16px">
        <strong style="color:#333">N\u00e3o foi voc\u00ea?</strong><br>
        Se voc\u00ea n\u00e3o solicitou esta redefini\u00e7\u00e3o, ignore este email. Sua conta permanece segura.
      </td></tr>
    </table>
    <p style="font-size:12px;color:#999;margin:20px 0 0;line-height:1.6">Caso o bot\u00e3o n\u00e3o funcione, copie e cole o link abaixo no seu navegador:</p>
    <table cellpadding="10" cellspacing="0" style="background:#f0f2f5;border-radius:8px;margin:8px 0 0;width:100%">
      <tr><td style="font-size:12px;color:#38bdf8;word-break:break-all;line-height:1.5;padding:10px 14px;font-family:monospace">${resetLink}</td></tr>
    </table>
  `);

  try {
    const info = await sendEmail(email, 'BR Service - Recuperação de Senha', emailHtml);
    console.log(`[SMTP] Email enviado com sucesso:`, info.messageId || info);
  } catch (err) {
    console.error('[SMTP] Erro ao enviar email:', err);
    return res.status(500).json({ error: 'Erro ao enviar email de recuperação. Verifique a configuração SMTP.', detail: err.message });
  }

  res.json({ message: 'Se o email existir, você receberá um link de recuperação.' });
});

app.post('/api/test-email', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Informe o email de destino.' });
  try {
    const info = await sendEmail(to, 'BR Service - Teste SMTP', '<p>Teste de envio SMTP funcionando!</p>');
    console.log('[SMTP TEST] Enviado:', info.messageId || info);
    res.json({ success: true, message: 'Email de teste enviado!' });
  } catch (err) {
    console.error('[SMTP TEST] Erro:', err);
    res.status(500).json({ error: 'Falha ao enviar email de teste.', detail: err.message });
  }
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

// ======================== CHAT ========================

app.get('/api/tasks/:id/chat', (req, res) => {
  const taskId = parseInt(req.params.id);
  const userId = parseInt(req.query.userId);
  if (!taskId || !userId) return res.status(400).json({ error: 'Task e usuario sao obrigatorios.' });

  const taskResult = db.exec(`SELECT id, title, clientId, clientName, professionalId, professionalName FROM tasks WHERE id = ${taskId}`);
  if (!taskResult.length || !taskResult[0].values.length) {
    return res.status(404).json({ error: 'Tarefa nao encontrada.' });
  }

  const taskRow = taskResult[0].values[0];
  const task = {
    id: taskRow[0],
    title: taskRow[1],
    clientId: taskRow[2],
    clientName: taskRow[3],
    professionalId: taskRow[4],
    professionalName: taskRow[5]
  };

  if (!task.professionalId || !task.clientId) {
    return res.status(400).json({ error: 'A tarefa ainda nao possui cliente e profissional.' });
  }

  if (userId !== task.clientId && userId !== task.professionalId) {
    return res.status(403).json({ error: 'Sem permissao para acessar o chat.' });
  }

  const messagesResult = db.exec(`
    SELECT id, senderId, senderName, senderRole, message, createdAt
    FROM chat_messages
    WHERE taskId = ${taskId}
    ORDER BY id ASC
  `);

  const messages = !messagesResult.length ? [] : messagesResult[0].values.map(v => ({
    id: v[0],
    senderId: v[1],
    senderName: v[2],
    senderRole: v[3],
    message: v[4],
    createdAt: v[5]
  }));

  res.json({
    task: {
      id: task.id,
      title: task.title,
      clientName: task.clientName,
      professionalName: task.professionalName || 'Profissional'
    },
    messages
  });
});

app.post('/api/tasks/:id/chat', (req, res) => {
  const taskId = parseInt(req.params.id);
  const { userId, message } = req.body;
  if (!taskId || !userId || !message) {
    return res.status(400).json({ error: 'Mensagem invalida.' });
  }

  const taskResult = db.exec(`SELECT clientId, professionalId FROM tasks WHERE id = ${taskId}`);
  if (!taskResult.length || !taskResult[0].values.length) {
    return res.status(404).json({ error: 'Tarefa nao encontrada.' });
  }

  const taskClientId = taskResult[0].values[0][0];
  const taskProfessionalId = taskResult[0].values[0][1];
  if (!taskProfessionalId || !taskClientId) {
    return res.status(400).json({ error: 'A tarefa ainda nao possui cliente e profissional.' });
  }

  if (userId !== taskClientId && userId !== taskProfessionalId) {
    return res.status(403).json({ error: 'Sem permissao para enviar mensagem.' });
  }

  const userResult = db.exec(`SELECT id, name, role FROM users WHERE id = ${parseInt(userId)}`);
  if (!userResult.length || !userResult[0].values.length) {
    return res.status(403).json({ error: 'Usuario nao encontrado.' });
  }

  const senderName = userResult[0].values[0][1];
  const senderRole = userResult[0].values[0][2];

  const safeName = safeSql(senderName);
  const safeRole = safeSql(senderRole);
  const safeMessage = safeSql(message);

  const id = Date.now();
  db.run(`
    INSERT INTO chat_messages (id, taskId, senderId, senderName, senderRole, message)
    VALUES (${id}, ${taskId}, ${userId}, '${safeName}', '${safeRole}', '${safeMessage}')
  `);
  saveDb();

  res.json({ success: true });
});

app.get('/api/user-chats', (req, res) => {
  const userId = parseInt(req.query.userId);
  if (!userId) return res.status(400).json({ error: 'Usuario obrigatorio.' });

  const tasksResult = db.exec(`
    SELECT id, title, clientId, clientName, professionalId, professionalName, status
    FROM tasks
    WHERE (clientId = ${userId} OR professionalId = ${userId})
      AND status = 'in_progress'
      AND professionalId IS NOT NULL
      AND professionalId != 0
      AND clientId IS NOT NULL
      AND clientId != 0
    ORDER BY id DESC
  `);

  const chats = [];
  if (tasksResult.length) {
    for (const row of tasksResult[0].values) {
      const taskId = row[0];
      const title = row[1];
      const clientId = row[2];
      const clientName = row[3];
      const professionalId = row[4];
      const professionalName = row[5];

      const lastMsgResult = db.exec(`
        SELECT message, senderName, createdAt FROM chat_messages
        WHERE taskId = ${taskId}
        ORDER BY id DESC LIMIT 1
      `);
      let lastMessage = null;
      if (lastMsgResult.length && lastMsgResult[0].values.length) {
        lastMessage = {
          message: lastMsgResult[0].values[0][0],
          senderName: lastMsgResult[0].values[0][1],
          createdAt: lastMsgResult[0].values[0][2]
        };
      }

      const otherName = userId === clientId ? professionalName : clientName;

      chats.push({
        id: taskId,
        type: 'task',
        title,
        otherName,
        lastMessage
      });
    }
  }

  res.json(chats);
});

// ======================== SUPPORT CHAT ========================

app.get('/api/support-chat', (req, res) => {
  const userId = parseInt(req.query.userId);
  const viewerId = parseInt(req.query.viewerId);
  const viewerRole = (req.query.viewerRole || '').toLowerCase();

  if (!userId || !viewerId || !viewerRole) {
    return res.status(400).json({ error: 'Parametros invalidos.' });
  }

  if (viewerRole !== 'admin' && viewerId !== userId) {
    return res.status(403).json({ error: 'Sem permissao para acessar o suporte.' });
  }

  const userResult = db.exec(`SELECT id, name FROM users WHERE id = ${userId}`);
  if (!userResult.length || !userResult[0].values.length) {
    return res.status(404).json({ error: 'Usuario nao encontrado.' });
  }

  const user = { id: userResult[0].values[0][0], name: userResult[0].values[0][1] };

  const messagesResult = db.exec(`
    SELECT id, senderId, senderName, senderRole, message, createdAt
    FROM support_messages
    WHERE userId = ${userId}
    ORDER BY id ASC
  `);

  const messages = !messagesResult.length ? [] : messagesResult[0].values.map(v => ({
    id: v[0],
    senderId: v[1],
    senderName: v[2],
    senderRole: v[3],
    message: v[4],
    createdAt: v[5]
  }));

  res.json({ user, messages });
});

app.post('/api/support-chat', (req, res) => {
  const { userId, senderId, senderRole, message } = req.body;
  if (!userId || !senderId || !senderRole || !message) {
    return res.status(400).json({ error: 'Mensagem invalida.' });
  }

  const safeMessage = safeSql(message);
  const safeRole = safeSql(senderRole);

  let safeName = 'Suporte';
  let finalSenderId = parseInt(senderId);
  let finalSenderRole = safeRole;

  if (String(senderRole).toLowerCase() !== 'admin') {
    if (parseInt(senderId) !== parseInt(userId)) {
      return res.status(403).json({ error: 'Sem permissao para enviar mensagem.' });
    }

    const userResult = db.exec(`SELECT id, name, role FROM users WHERE id = ${parseInt(userId)}`);
    if (!userResult.length || !userResult[0].values.length) {
      return res.status(404).json({ error: 'Usuario nao encontrado.' });
    }

    safeName = safeSql(userResult[0].values[0][1]);
    finalSenderRole = safeSql(userResult[0].values[0][2]);
  } else {
    finalSenderId = 0;
    finalSenderRole = 'admin';
    safeName = 'Suporte';
  }

  const id = Date.now();
  db.run(`
    INSERT INTO support_messages (id, userId, senderId, senderName, senderRole, message)
    VALUES (${id}, ${parseInt(userId)}, ${finalSenderId}, '${safeName}', '${finalSenderRole}', '${safeMessage}')
  `);
  saveDb();

  res.json({ success: true });
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
  const {
    title,
    description,
    budget,
    creatorId,
    creatorName,
    creatorRole,
    clientId,
    clientName,
    professionalId,
    professionalName
  } = req.body;

  const finalTitle = String(title || '').trim();
  const finalDesc = String(description || '').trim();
  const finalBudget = Number(budget);

  if (!finalTitle || !finalDesc || Number.isNaN(finalBudget)) {
    return res.status(400).json({ error: 'Preencha todos os campos.' });
  }

  let finalCreatorId = creatorId || clientId || professionalId;
  let finalCreatorName = creatorName || clientName || professionalName;
  let finalCreatorRole = creatorRole || (professionalId ? 'profissional' : (clientId ? 'cliente' : null));

  if (!finalCreatorId) {
    return res.status(400).json({ error: 'Preencha todos os campos.' });
  }

  if (!finalCreatorRole || !finalCreatorName) {
    const userResult = db.exec(`SELECT name, role FROM users WHERE id = ${parseInt(finalCreatorId)}`);
    if (!userResult.length || !userResult[0].values.length) {
      return res.status(400).json({ error: 'Preencha todos os campos.' });
    }
    finalCreatorName = finalCreatorName || userResult[0].values[0][0];
    finalCreatorRole = finalCreatorRole || userResult[0].values[0][1];
  }

  const id = Date.now();
  const safeTitle = safeSql(finalTitle);
  const safeDesc = safeSql(finalDesc);
  const safeCreatorName = safeSql(finalCreatorName);
  const role = String(finalCreatorRole).toLowerCase();

  if (role === 'profissional') {
    db.run(`
      INSERT INTO tasks (id, title, description, budget, status, clientId, clientName, professionalId, professionalName)
      VALUES (${id}, '${safeTitle}', '${safeDesc}', ${finalBudget}, 'open', 0, 'Aguardando cliente', ${parseInt(finalCreatorId)}, '${safeCreatorName}')
    `);
    saveDb();

    return res.json({
      id,
      title: finalTitle,
      description: finalDesc,
      budget: finalBudget,
      status: 'open',
      clientId: 0,
      clientName: 'Aguardando cliente',
      professionalId: parseInt(finalCreatorId),
      professionalName: finalCreatorName
    });
  }

  if (role !== 'cliente') {
    return res.status(400).json({ error: 'Perfil inválido para criar tarefa.' });
  }

  db.run(`
    INSERT INTO tasks (id, title, description, budget, status, clientId, clientName)
    VALUES (${id}, '${safeTitle}', '${safeDesc}', ${finalBudget}, 'open', ${parseInt(finalCreatorId)}, '${safeCreatorName}')
  `);
  saveDb();

  res.json({
    id,
    title: finalTitle,
    description: finalDesc,
    budget: finalBudget,
    status: 'open',
    clientId: parseInt(finalCreatorId),
    clientName: finalCreatorName,
    professionalId: null,
    professionalName: null
  });
});

app.put('/api/tasks/:id/accept', (req, res) => {
  const { id } = req.params;
  const { professionalId, professionalName } = req.body;

  const result = db.exec(`SELECT status, professionalId FROM tasks WHERE id = ${parseInt(id)}`);
  if (!result.length || !result[0].values.length) {
    return res.status(404).json({ error: 'Tarefa não encontrada.' });
  }
  if (result[0].values[0][0] !== 'open') {
    return res.status(400).json({ error: 'Tarefa já foi aceita.' });
  }

  if (result[0].values[0][1]) {
    return res.status(400).json({ error: 'Tarefa já possui profissional.' });
  }

  const safeName = professionalName.replace(/'/g, "''");
  db.run(`UPDATE tasks SET status = 'in_progress', professionalId = ${professionalId}, professionalName = '${safeName}' WHERE id = ${parseInt(id)}`);
  saveDb();

  res.json({ success: true });
});

app.put('/api/tasks/:id/accept-client', (req, res) => {
  const { id } = req.params;
  const { clientId, clientName } = req.body;

  if (!clientId || !clientName) {
    return res.status(400).json({ error: 'Cliente inválido.' });
  }

  const result = db.exec(`SELECT status, clientId, professionalId FROM tasks WHERE id = ${parseInt(id)}`);
  if (!result.length || !result[0].values.length) {
    return res.status(404).json({ error: 'Tarefa não encontrada.' });
  }

  const status = result[0].values[0][0];
  const existingClientId = result[0].values[0][1];
  const professionalId = result[0].values[0][2];

  if (status !== 'open') {
    return res.status(400).json({ error: 'Tarefa não está aberta.' });
  }

  if (!professionalId) {
    return res.status(400).json({ error: 'Tarefa não foi criada por um profissional.' });
  }

  if (existingClientId && existingClientId !== 0) {
    return res.status(400).json({ error: 'Tarefa já possui cliente.' });
  }

  const safeName = safeSql(clientName);
  db.run(`
    UPDATE tasks
    SET status = 'in_progress', clientId = ${clientId}, clientName = '${safeName}'
    WHERE id = ${parseInt(id)}
  `);
  saveDb();

  res.json({ success: true });
});

app.put('/api/tasks/:id/complete', (req, res) => {
  const { id } = req.params;
  const { clientId } = req.body;

  const result = db.exec(`SELECT clientId, clientName, status, title, professionalId, professionalName FROM tasks WHERE id = ${parseInt(id)}`);
  if (!result.length || !result[0].values.length) {
    return res.status(404).json({ error: 'Tarefa não encontrada.' });
  }

  const row = result[0].values[0];
  const taskClientId = row[0];
  const taskClientName = row[1];
  const taskStatus = row[2];
  const taskTitle = row[3];
  const professionalId = row[4];
  const taskProfessionalName = row[5];

  if (taskClientId !== clientId) return res.status(403).json({ error: 'Apenas o cliente pode concluir.' });
  if (taskStatus !== 'in_progress') return res.status(400).json({ error: 'Tarefa não está em andamento.' });

  db.run(`UPDATE tasks SET status = 'completed' WHERE id = ${parseInt(id)}`);
  saveDb();

  // Notify support, client, and professional
  const clientResult = db.exec(`SELECT name, whatsapp, email FROM users WHERE id = ${parseInt(clientId)}`);
  let clientName = taskClientName || clientId;
  let clientWpp = 'não informado';
  let clientEmail = '';
  if (clientResult.length && clientResult[0].values.length) {
    clientName = clientResult[0].values[0][0];
    clientWpp = clientResult[0].values[0][1] || 'não informado';
    clientEmail = clientResult[0].values[0][2] || '';
  }

  const hasProfessional = professionalId !== null && professionalId !== undefined;
  let professionalName = taskProfessionalName || 'Profissional';
  let professionalEmail = '';
  let professionalWpp = 'não informado';
  if (hasProfessional) {
    const profResult = db.exec(`SELECT name, whatsapp, email FROM users WHERE id = ${parseInt(professionalId)}`);
    if (profResult.length && profResult[0].values.length) {
      professionalName = profResult[0].values[0][0];
      professionalWpp = profResult[0].values[0][1] || 'não informado';
      professionalEmail = profResult[0].values[0][2] || '';
    }
  }

  const supportEmail = process.env.SUPPORT_EMAIL || process.env.SMTP_USER || 'suporte@brservice.com';
  const detailsHtml = `
<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 8px"><strong>Tarefa:</strong> ${taskTitle}</p>
<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 8px"><strong>Cliente:</strong> ${clientName}</p>
<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 8px"><strong>WhatsApp:</strong> ${clientWpp}</p>
${hasProfessional ? `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 8px"><strong>Profissional:</strong> ${professionalName}</p>` : ''}
${hasProfessional ? `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 8px"><strong>WhatsApp Prof.:</strong> ${professionalWpp}</p>` : ''}`;

  function baseTemplate(icon, heading, body) {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
        <tr><td style="padding:0 0 28px;text-align:center">
          <table cellpadding="0" cellspacing="0" style="display:inline-block">
            <tr><td style="background:#0b1220;padding:10px 22px;border-radius:10px">
              <span style="color:#38bdf8;font-size:20px;font-weight:800;letter-spacing:1.5px">BR</span>
              <span style="color:#fff;font-size:20px;font-weight:300;letter-spacing:2px">SERVICE</span>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.08)">
          <table cellpadding="0" cellspacing="0" width="100%">
            <tr><td style="background:linear-gradient(145deg,#0b1220 0%,#162044 50%,#0b1220 100%);padding:40px 36px 28px;text-align:center;position:relative">
              <div style="position:absolute;top:0;left:0;right:0;bottom:0;opacity:0.08;background-image:radial-gradient(circle at 20% 40%,#38bdf8 0%,transparent 60%),radial-gradient(circle at 80% 60%,#22d3ee 0%,transparent 50%)"></div>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 16px">
                <tr><td style="width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#38bdf8,#22d3ee);text-align:center;vertical-align:middle;font-size:26px;line-height:60px;box-shadow:0 8px 24px rgba(56,189,248,0.35)">${icon}</td></tr>
              </table>
              <h1 style="color:#ffffff;font-size:24px;font-weight:700;margin:0;letter-spacing:-0.3px">${heading}</h1>
            </td></tr>
            <tr><td style="padding:36px 36px 16px">
              ${body}
            </td></tr>
            <tr><td style="padding:20px 36px;border-top:1px solid #eef0f4;text-align:center">
              <p style="font-size:11px;color:#bbb;margin:0">BR Service — Plataforma de tarefas de programa\u00e7\u00e3o</p>
              <p style="font-size:11px;color:#ccc;margin:4px 0 0">© 2026 BR Service. Todos os direitos reservados.</p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }

  function taskInfoTable(rows) {
    let r = '';
    rows.forEach((row, i) => {
      r += `<tr><td style="font-size:14px;color:#333;padding:12px 16px${i > 0 ? ';border-top:1px solid #e8e8e8' : ''}"><strong>${row.label}:</strong> ${row.value}</td></tr>`;
    });
    return `<table cellpadding="0" cellspacing="0" style="background:#f7f8fa;border-radius:12px;margin:16px 0;width:100%">${r}</table>`;
  }

  const emailJobs = [];

  emailJobs.push(sendEmail(
    supportEmail,
    'BR Service - Atividade Concluída',
    baseTemplate('✅', 'Atividade Concluída', `
      <p style="font-size:15px;color:#1a1a2e;margin:0 0 16px"><strong>Uma atividade foi conclu\u00edda!</strong></p>
      ${taskInfoTable([
        { label: 'Tarefa', value: taskTitle },
        { label: 'Cliente', value: clientName },
        { label: 'WhatsApp', value: clientWpp },
        ...(hasProfessional ? [{ label: 'Profissional', value: professionalName }, { label: 'WhatsApp Prof.', value: professionalWpp }] : [])
      ])}
    `)
  ).catch(err => console.error('Erro ao notificar suporte:', err)));

  if (clientEmail) {
    emailJobs.push(sendEmail(
      clientEmail,
      'BR Service - Tarefa concluída',
      baseTemplate('🎉', 'Tarefa Concluída', `
        <p style="font-size:16px;color:#1a1a2e;margin:0 0 16px">Ol\u00e1 <strong style="color:#0b1220">${clientName}</strong>,</p>
        <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 8px">Sua tarefa foi marcada como <strong>conclu\u00edda</strong> com sucesso! 🎉</p>
        ${taskInfoTable([
          { label: 'Tarefa', value: taskTitle },
          ...(hasProfessional ? [{ label: 'Profissional', value: professionalName }] : [])
        ])}
        <p style="font-size:13px;color:#888;line-height:1.6;margin:16px 0 0">Se precisar de suporte, responda este email ou entre em contato pelo nosso WhatsApp.</p>
      `)
    ).catch(err => console.error('Erro ao notificar cliente:', err)));
  }

  if (professionalEmail) {
    emailJobs.push(sendEmail(
      professionalEmail,
      'BR Service - Tarefa concluída pelo cliente',
      baseTemplate('👏', 'Tarefa Concluída', `
        <p style="font-size:16px;color:#1a1a2e;margin:0 0 16px">Ol\u00e1 <strong style="color:#0b1220">${professionalName}</strong>,</p>
        <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 8px">O cliente concluiu a tarefa abaixo. Obrigado pelo seu trabalho! 👏</p>
        ${taskInfoTable([
          { label: 'Tarefa', value: taskTitle },
          { label: 'Cliente', value: clientName }
        ])}
        <p style="font-size:13px;color:#888;line-height:1.6;margin:16px 0 0">Continue assim e mantenha seu hist\u00f3rico de entregas atualizado!</p>
      `)
    ).catch(err => console.error('Erro ao notificar profissional:', err)));
  }

  void Promise.allSettled(emailJobs);

  res.json({ success: true });
});

// ======================== ONBOARDING ========================

app.get('/api/onboarding/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Usuario obrigatorio.' });

  const result = db.exec(`SELECT userId, bio, skills, portfolio, linkedin, availability, experience, categories, hourlyRate, photo, createdAt FROM onboarding WHERE userId = ${userId}`);
  if (!result.length || !result[0].values.length) {
    return res.json({ completed: false });
  }
  const row = result[0].values[0];
  res.json({
    completed: true,
    userId: row[0],
    bio: row[1],
    skills: row[2],
    portfolio: row[3],
    linkedin: row[4],
    availability: row[5],
    experience: row[6],
    categories: row[7],
    hourlyRate: row[8],
    photo: row[9],
    createdAt: row[10]
  });
});

app.post('/api/onboarding/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Usuario obrigatorio.' });

  const { bio, skills, portfolio, linkedin, availability, experience, categories, hourlyRate, photo } = req.body;
  if (!bio || !skills || !availability) {
    return res.status(400).json({ error: 'Preencha bio, habilidades e disponibilidade.' });
  }

  const safeBio = safeSql(bio);
  const safeSkills = safeSql(skills);
  const safePortfolio = safeSql(portfolio || '');
  const safeLinkedin = safeSql(linkedin || '');
  const safeAvailability = safeSql(availability);
  const safeExperience = safeSql(experience || '');
  const safeCategories = safeSql(categories || '');
  const rate = parseFloat(hourlyRate) || 0;
  const safePhoto = safeSql(photo || '');

  const existing = db.exec(`SELECT userId FROM onboarding WHERE userId = ${userId}`);
  if (existing.length && existing[0].values.length) {
    db.run(`
      UPDATE onboarding
      SET bio = '${safeBio}', skills = '${safeSkills}', portfolio = '${safePortfolio}',
          linkedin = '${safeLinkedin}', availability = '${safeAvailability}',
          experience = '${safeExperience}', categories = '${safeCategories}',
          hourlyRate = ${rate}, photo = '${safePhoto}',
          createdAt = datetime('now')
      WHERE userId = ${userId}
    `);
  } else {
    db.run(`
      INSERT INTO onboarding (userId, bio, skills, portfolio, linkedin, availability, experience, categories, hourlyRate, photo)
      VALUES (${userId}, '${safeBio}', '${safeSkills}', '${safePortfolio}',
              '${safeLinkedin}', '${safeAvailability}', '${safeExperience}',
              '${safeCategories}', ${rate}, '${safePhoto}')
    `);
  }
  saveDb();

  res.json({ success: true });
});

app.get('/api/onboarding/check/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Usuario obrigatorio.' });

  const result = db.exec(`SELECT userId FROM onboarding WHERE userId = ${userId}`);
  const completed = result.length && result[0].values.length > 0;
  res.json({ completed });
});

// ======================== ONBOARDING REMINDERS ========================

const REMINDER_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MIN_AGE_FOR_REMINDER_MS = 2 * 60 * 60 * 1000; // 2 hours after registration
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // wait 24h between reminders

function onboardingEmailTemplate(icon, heading, body) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
        <tr><td style="padding:0 0 28px;text-align:center">
          <table cellpadding="0" cellspacing="0" style="display:inline-block">
            <tr><td style="background:#0b1220;padding:10px 22px;border-radius:10px">
              <span style="color:#38bdf8;font-size:20px;font-weight:800;letter-spacing:1.5px">BR</span>
              <span style="color:#fff;font-size:20px;font-weight:300;letter-spacing:2px">SERVICE</span>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.08)">
          <table cellpadding="0" cellspacing="0" width="100%">
            <tr><td style="background:linear-gradient(145deg,#0b1220 0%,#162044 50%,#0b1220 100%);padding:40px 36px 28px;text-align:center;position:relative">
              <div style="position:absolute;top:0;left:0;right:0;bottom:0;opacity:0.08;background-image:radial-gradient(circle at 20% 40%,#38bdf8 0%,transparent 60%),radial-gradient(circle at 80% 60%,#22d3ee 0%,transparent 50%)"></div>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 16px">
                <tr><td style="width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#38bdf8,#22d3ee);text-align:center;vertical-align:middle;font-size:26px;line-height:60px;box-shadow:0 8px 24px rgba(56,189,248,0.35)">${icon}</td></tr>
              </table>
              <h1 style="color:#ffffff;font-size:24px;font-weight:700;margin:0;letter-spacing:-0.3px">${heading}</h1>
            </td></tr>
            <tr><td style="padding:36px 36px 16px">
              ${body}
            </td></tr>
            <tr><td style="padding:20px 36px;border-top:1px solid #eef0f4;text-align:center">
              <p style="font-size:11px;color:#bbb;margin:0">BR Service — Plataforma de tarefas de programa\u00e7\u00e3o</p>
              <p style="font-size:11px;color:#ccc;margin:4px 0 0">© 2026 BR Service. Todos os direitos reservados.</p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function getOnboardingReminderBody(count, daysSinceReg) {
  const messages = [
    {
      subject: 'Complete seu perfil na BR Service',
      body: `
        <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 16px">Ol\u00e1!</p>
        <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 16px">
          Notamos que voc\u00ea se cadastrou na <strong>BR Service</strong> como profissional,
          mas ainda n\u00e3o completou seu perfil.
        </p>
        <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 16px">
          Com um perfil completo, os clientes podem conhecer suas habilidades,
          experi\u00eancia e disponibilidade — aumentando suas chances de ser contratado!
        </p>`
    },
    {
      subject: 'BR Service — Seu perfil est\u00e1 incompleto',
      body: `
        <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 16px">Ol\u00e1!</p>
        <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 16px">
          J\u00e1 se passaram alguns dias desde que voc\u00ea se cadastrou e seu perfil profissional
          ainda n\u00e3o foi preenchido.
        </p>
        <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 16px">
          <strong>Clientes est\u00e3o procurando profissionais como voc\u00ea!</strong>
          N\u00e3o perca oportunidades — complete seu perfil e comece a receber propostas.
        </p>`
    },
    {
      subject: 'Ultimo aviso! Complete seu perfil na BR Service',
      body: `
        <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 16px">Ol\u00e1!</p>
        <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 16px">
          Este \u00e9 nosso <strong>\u00faltimo lembrete</strong> sobre a finaliza\u00e7\u00e3o do seu perfil.
        </p>
        <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 16px">
          Sem um perfil completo, os clientes n\u00e3o conseguem ver suas informa\u00e7\u00f5es
          e voc\u00ea pode estar perdendo oportunidades de trabalho.
        </p>
        <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 16px">
          Acesse sua conta agora e complete seu cadastro em poucos minutos!
        </p>`
    }
  ];
  const idx = Math.min(count, messages.length - 1);
  return messages[idx];
}

async function checkOnboardingReminders() {
  if (!transporter) {
    console.log('[ONBOARDING REMINDER] SMTP nao configurado. Pulando lembretes.');
    return;
  }

  try {
    const now = new Date().toISOString().replace('T', ' ').replace(/\..+/, '');
    const cutoff = new Date(Date.now() - MIN_AGE_FOR_REMINDER_MS).toISOString().replace('T', ' ').replace(/\..+/, '');
    const cooldownCutoff = new Date(Date.now() - COOLDOWN_MS).toISOString().replace('T', ' ').replace(/\..+/, '');

    const rows = db.exec(`
      SELECT u.id, u.name, u.email, u.createdAt, u.onboardingReminderCount, u.lastOnboardingReminder
      FROM users u
      LEFT JOIN onboarding o ON o.userId = u.id
      WHERE u.role = 'profissional'
        AND o.userId IS NULL
        AND u.createdAt < '${cutoff}'
        AND (u.lastOnboardingReminder IS NULL OR u.lastOnboardingReminder < '${cooldownCutoff}')
      LIMIT 20
    `);

    if (!rows.length || !rows[0].values.length) {
      console.log('[ONBOARDING REMINDER] Nenhum profissional para lembrar.');
      return;
    }

    for (const row of rows[0].values) {
      const userId = row[0];
      const name = row[1];
      const email = row[2];
      const createdAt = row[3];
      const reminderCount = row[4] || 0;

      const daysSinceReg = createdAt
        ? Math.floor((Date.now() - new Date(createdAt + 'Z').getTime()) / (1000 * 60 * 60 * 24))
        : 0;

      const msg = getOnboardingReminderBody(reminderCount, daysSinceReg);

      const emailHtml = onboardingEmailTemplate('&#128640;', 'Complete seu perfil!', msg.body + `
        <table cellpadding="0" cellspacing="0" style="margin:24px 0 8px">
          <tr><td align="center">
            <a href="${APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#38bdf8,#22d3ee);color:#0b1220;text-decoration:none;font-size:15px;font-weight:700;padding:14px 36px;border-radius:12px;box-shadow:0 8px 24px rgba(56,189,248,0.3)">ACESSAR MINHA CONTA</a>
          </td></tr>
        </table>
        <p style="font-size:13px;color:#999;margin:20px 0 0;text-align:center">Se voce ja completou seu perfil, ignore esta mensagem.</p>
      `);

      try {
        await sendEmail(email, msg.subject, emailHtml);
        const newCount = (reminderCount || 0) + 1;
        db.run(`
          UPDATE users
          SET lastOnboardingReminder = '${now}', onboardingReminderCount = ${newCount}
          WHERE id = ${userId}
        `);
        saveDb();
        console.log(`[ONBOARDING REMINDER] Lembrete #${newCount} enviado para ${name} <${email}>`);
      } catch (err) {
        console.error(`[ONBOARDING REMINDER] Erro ao enviar para ${email}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[ONBOARDING REMINDER] Erro na verificacao:', err.message);
  }
}

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
      // Start onboarding reminder scheduler
      checkOnboardingReminders();
      setInterval(checkOnboardingReminders, REMINDER_INTERVAL_MS);
      console.log(`[ONBOARDING REMINDER] Verificação agendada a cada ${REMINDER_INTERVAL_MS / 3600000}h`);
    });
  })
  .catch(err => {
    console.error('Erro ao iniciar:', err);
    process.exit(1);
  });
