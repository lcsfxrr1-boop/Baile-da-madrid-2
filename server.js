const express = require('express');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const { google } = require('googleapis');

const app = express();

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const PUBLIC_KEY = process.env.MP_PUBLIC_KEY || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || '';
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
const GMAIL_REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || '';
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN || '';

const EVENT_NAME = 'Baile da Madrid 2.0';
const POSTER_PATH = path.join(__dirname, 'baile-madrid-poster.png');

const batches = {
  // Pré-venda e VIP são unissex.
  pre: { name: 'Pré-Venda', price: 15 },
  lounge: { name: 'Área VIP', price: 70 },

  // A partir do 1º lote, o ingresso masculino custa R$ 5 a mais.
  'lote1-feminino': { name: '1º Lote — Feminino', price: 20 },
  'lote1-masculino': { name: '1º Lote — Masculino', price: 25 },
  'lote2-feminino': { name: '2º Lote — Feminino', price: 25 },
  'lote2-masculino': { name: '2º Lote — Masculino', price: 30 },
  'lote3-feminino': { name: '3º Lote — Feminino', price: 30 },
  'lote3-masculino': { name: '3º Lote — Masculino', price: 35 },

  // IDs antigos continuam apontando para a opção feminina correspondente.
  lote1: { name: '1º Lote — Feminino', price: 20 },
  lote2: { name: '2º Lote — Feminino', price: 25 },
  lote3: { name: '3º Lote — Feminino', price: 30 }
};

/* ========================================================
   GMAIL API / OAUTH2
   ======================================================== */

function gmailReady() {
  return Boolean(
    GMAIL_CLIENT_ID &&
    GMAIL_CLIENT_SECRET &&
    GMAIL_REDIRECT_URI &&
    GMAIL_USER &&
    GMAIL_REFRESH_TOKEN
  );
}

function getGmailClient() {
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REDIRECT_URI) {
    throw new Error('Credenciais da Gmail API não configuradas.');
  }

  const oauth2Client = new google.auth.OAuth2(
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    GMAIL_REDIRECT_URI
  );

  if (GMAIL_REFRESH_TOKEN) {
    oauth2Client.setCredentials({
      refresh_token: GMAIL_REFRESH_TOKEN
    });
  }

  return oauth2Client;
}

function getGmailService() {
  return google.gmail({
    version: 'v1',
    auth: getGmailClient()
  });
}

function base64UrlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function createMimeMessage({ from, to, subject, text, html, attachments = [], inlineAttachments = [] }) {
  const mixedBoundary = `mixed_${crypto.randomBytes(12).toString('hex')}`;
  const relatedBoundary = `related_${crypto.randomBytes(12).toString('hex')}`;
  const alternativeBoundary = `alternative_${crypto.randomBytes(12).toString('hex')}`;

  let message = '';

  message += `From: ${from}\r\n`;
  message += `To: ${to}\r\n`;
  message += `Subject: ${subject}\r\n`;
  message += `MIME-Version: 1.0\r\n`;
  message += `Content-Type: multipart/mixed; boundary="${mixedBoundary}"\r\n`;
  message += `\r\n`;

  // Corpo + imagens CID usadas diretamente pelo HTML.
  message += `--${mixedBoundary}\r\n`;
  message += `Content-Type: multipart/related; boundary="${relatedBoundary}"\r\n`;
  message += `\r\n`;

  message += `--${relatedBoundary}\r\n`;
  message += `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"\r\n`;
  message += `\r\n`;

  message += `--${alternativeBoundary}\r\n`;
  message += `Content-Type: text/plain; charset="UTF-8"\r\n`;
  message += `Content-Transfer-Encoding: 8bit\r\n`;
  message += `\r\n`;
  message += `${text || ''}\r\n\r\n`;

  message += `--${alternativeBoundary}\r\n`;
  message += `Content-Type: text/html; charset="UTF-8"\r\n`;
  message += `Content-Transfer-Encoding: 8bit\r\n`;
  message += `\r\n`;
  message += `${html || ''}\r\n\r\n`;

  message += `--${alternativeBoundary}--\r\n`;

  for (const attachment of inlineAttachments) {
    message += `--${relatedBoundary}\r\n`;
    message += `Content-Type: ${attachment.contentType || 'application/octet-stream'}; name="${attachment.filename}"\r\n`;
    message += `Content-Disposition: inline; filename="${attachment.filename}"\r\n`;
    message += `Content-Transfer-Encoding: base64\r\n`;
    if (attachment.contentId) {
      message += `Content-ID: <${attachment.contentId}>\r\n`;
    }
    message += `\r\n`;
    const content = Buffer.from(String(attachment.content || ''), 'base64').toString('base64');
    for (let i = 0; i < content.length; i += 76) {
      message += content.substring(i, i + 76) + '\r\n';
    }
    message += `\r\n`;
  }

  message += `--${relatedBoundary}--\r\n`;

  // Anexos normais ficam fora do multipart/related.
  for (const attachment of attachments) {
    message += `--${mixedBoundary}\r\n`;
    message += `Content-Type: ${attachment.contentType || 'application/octet-stream'}; name="${attachment.filename}"\r\n`;
    message += `Content-Disposition: attachment; filename="${attachment.filename}"\r\n`;
    message += `Content-Transfer-Encoding: base64\r\n`;
    message += `\r\n`;
    const content = Buffer.from(String(attachment.content || ''), 'base64').toString('base64');
    for (let i = 0; i < content.length; i += 76) {
      message += content.substring(i, i + 76) + '\r\n';
    }
    message += `\r\n`;
  }

  message += `--${mixedBoundary}--\r\n`;
  return message;
}

async function sendGmail({ to, subject, text, html, attachments = [], inlineAttachments = [] }) {
  if (!gmailReady()) {
    throw new Error(
      'Gmail API não está configurada. Verifique GMAIL_CLIENT_ID, ' +
      'GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI, GMAIL_USER e GMAIL_REFRESH_TOKEN.'
    );
  }

  const gmail = getGmailService();

  const mime = createMimeMessage({
    from: GMAIL_USER,
    to,
    subject,
    text,
    html,
    attachments,
    inlineAttachments
  });

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: base64UrlEncode(mime)
    }
  });

  return result.data;
}

/* ========================================================
   AUTORIZAÇÃO GMAIL
   ======================================================== */

app.get('/api/gmail/auth', (req, res) => {
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REDIRECT_URI) {
    return res.status(500).send(
      'Configure GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET e GMAIL_REDIRECT_URI no Render.'
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    GMAIL_REDIRECT_URI
  );

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.send']
  });

  res.redirect(url);
});

app.get('/api/gmail/oauth2callback', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim();

    if (!code) {
      return res.status(400).send('Código OAuth não recebido.');
    }

    const oauth2Client = new google.auth.OAuth2(
      GMAIL_CLIENT_ID,
      GMAIL_CLIENT_SECRET,
      GMAIL_REDIRECT_URI
    );

    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      return res.status(500).send(
        'O Google não retornou um refresh token. Tente novamente usando /api/gmail/auth.'
      );
    }

    res.send(`
      <!doctype html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Gmail autorizado</title>
        <style>
          body{margin:0;padding:40px 20px;background:#070707;color:#fff;font-family:Arial,sans-serif}
          .box{max-width:700px;margin:auto;background:#111;border:1px solid #333;border-radius:16px;padding:25px}
          code{display:block;word-break:break-all;background:#000;padding:15px;border-radius:10px;margin-top:15px}
        </style>
      </head>
      <body>
        <div class="box">
          <h2>Gmail autorizado com sucesso!</h2>
          <p>Copie o Refresh Token abaixo e coloque no Render como:</p>
          <strong>GMAIL_REFRESH_TOKEN</strong>
          <code>${String(tokens.refresh_token).replace(/</g, '&lt;')}</code>
          <p>Depois de salvar a variável no Render, faça um novo deploy.</p>
        </div>
      </body>
      </html>
    `);
  } catch (e) {
    console.error('Erro OAuth Gmail:', e);
    res.status(500).send(`Erro ao autorizar Gmail: ${e.message || e}`);
  }
});

/* ========================================================
   BANCO DE DADOS
   ======================================================== */

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL não configurado.');
}

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5
    })
  : null;

async function db(query, params = []) {
  if (!pool) {
    throw new Error('DATABASE_URL não configurado.');
  }

  return pool.query(query, params);
}

async function initDb() {
  if (!pool) return;

  await db(`
    CREATE TABLE IF NOT EXISTS orders(
      order_id TEXT PRIMARY KEY,
      payment_id TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL,
      total NUMERIC(10,2) NOT NULL,
      buyer_name TEXT NOT NULL,
      buyer_email TEXT NOT NULL,
      buyer_cpf TEXT NOT NULL,
      buyer_phone TEXT NOT NULL,
      items JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ,
      email_sent_at TIMESTAMPTZ,
      email_error TEXT
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS tickets(
      ticket_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      batch_id TEXT NOT NULL,
      batch_name TEXT NOT NULL,
      unit_price NUMERIC(10,2) NOT NULL,
      buyer_name TEXT NOT NULL,
      buyer_email TEXT NOT NULL,
      qr_base64 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ
    )
  `);

  await db(`
    CREATE INDEX IF NOT EXISTS idx_tickets_token_hash
    ON tickets(token_hash)
  `);

  await db(`
    CREATE INDEX IF NOT EXISTS idx_tickets_order_id
    ON tickets(order_id)
  `);

  await db(`
    CREATE INDEX IF NOT EXISTS idx_tickets_ticket_id
    ON tickets(ticket_id)
  `);
}

/* ========================================================
   AUXILIARES
   ======================================================== */

function cleanCPF(v) {
  return String(v || '').replace(/\D/g, '');
}

function splitName(name) {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);

  return {
    first_name: p.shift() || 'Cliente',
    last_name: p.join(' ') || 'Baile Madrid'
  };
}

function calculateItems(items) {
  if (!Array.isArray(items) || !items.length) {
    throw new Error('Nenhum ingresso selecionado.');
  }

  let total = 0;
  const normalized = [];

  for (const item of items) {
    // O front-end pode enviar o VIP como "vip", enquanto o servidor
    // mantém esse ingresso cadastrado internamente como "lounge".
    const rawId = String(item?.id || '').trim().toLowerCase();
    const itemId = rawId === 'vip' ? 'lounge' : rawId;
    const batch = batches[itemId];
    const quantity = Number(item?.quantity);

    if (
      !batch ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 10
    ) {
      throw new Error('Ingresso ou quantidade inválida.');
    }

    total += batch.price * quantity;

    normalized.push({
      id: itemId,
      name: batch.name,
      quantity,
      unit_price: batch.price
    });
  }

  if (normalized.reduce((s, i) => s + i.quantity, 0) > 10) {
    throw new Error('Limite máximo de 10 ingressos por compra.');
  }

  return { normalized, total };
}

function totalTicketCount(order) {
  return (order.items || []).reduce(
    (sum, item) => sum + Number(item.quantity || 0),
    0
  );
}

function makeTicketCode() {
  return `BMD2-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function makeTicketToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function requireAdmin(req, res, next) {
  const supplied =
    req.get('x-admin-token') ||
    req.body?.adminToken ||
    req.query?.adminToken ||
    '';

  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      error: 'ADMIN_TOKEN não configurado no servidor.'
    });
  }

  if (supplied !== ADMIN_TOKEN) {
    return res.status(401).json({
      error: 'Acesso não autorizado.'
    });
  }

  next();
}

async function getOrder(orderId) {
  const r = await db(
    `
      SELECT
        order_id AS "orderId",
        payment_id AS "paymentId",
        status,
        total,
        buyer_name AS "buyerName",
        buyer_email AS "buyerEmail",
        buyer_cpf AS "buyerCpf",
        buyer_phone AS "buyerPhone",
        items,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        email_sent_at AS "emailSentAt",
        email_error AS "emailError"
      FROM orders
      WHERE order_id = $1
      LIMIT 1
    `,
    [orderId]
  );

  if (!r.rows[0]) return null;

  const row = r.rows[0];

  row.buyer = {
    name: row.buyerName,
    email: row.buyerEmail,
    cpf: row.buyerCpf,
    phone: row.buyerPhone
  };

  return row;
}

async function getTickets(orderId) {
  const r = await db(
    `
      SELECT
        ticket_id,
        order_id,
        token_hash,
        batch_id,
        batch_name,
        unit_price,
        buyer_name,
        buyer_email,
        qr_base64,
        created_at,
        used_at
      FROM tickets
      WHERE order_id = $1
      ORDER BY created_at ASC, ticket_id ASC
    `,
    [orderId]
  );

  return r.rows;
}

async function countTickets(orderId) {
  const r = await db(
    `SELECT COUNT(*)::int AS n FROM tickets WHERE order_id=$1`,
    [orderId]
  );

  return r.rows[0].n;
}

async function mpRequest(url, options = {}) {
  if (!ACCESS_TOKEN) {
    throw new Error('MP_ACCESS_TOKEN não configurado.');
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.cause?.[0]?.description ||
      `Mercado Pago respondeu HTTP ${response.status}.`;

    throw new Error(message);
  }

  return data;
}

function ticketPublicUrl(ticketId, token) {
  const base =
    PUBLIC_BASE_URL ||
    '';

  return `${base}/api/tickets/scan?ticket=${encodeURIComponent(token)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function ticketHtml(ticket) {
  const ticketId = ticket.ticket_id || ticket.ticketId || '';
  const buyerName = ticket.buyer_name || ticket.buyerName || '';
  const buyerCpf = ticket.buyer_cpf || ticket.buyerCpf || '';
  const batchName = ticket.batch_name || ticket.batchName || '';

  return `
    <div style="margin:0 auto 18px;padding:16px 18px;background:rgba(0,0,0,.78);border:1px solid rgba(255,255,255,.22);border-radius:14px;color:#fff;font-family:Arial,sans-serif;text-align:center">
      <div style="font-size:11px;color:#ff4052;letter-spacing:2px;text-transform:uppercase;font-weight:800">
        INGRESSO
      </div>
      <div style="font-size:18px;font-weight:800;margin:7px 0 12px">
        ${escapeHtml(batchName)}
      </div>
      <p style="margin:6px 0;font-size:15px">
        <strong>Nome: ${escapeHtml(buyerName)}</strong>
      </p>
      <p style="margin:6px 0;font-size:14px">
        <strong>CPF: ${formatCpfDisplay(buyerCpf)}</strong>
      </p>
      <p style="margin:10px 0 0;font-family:monospace;font-size:13px;word-break:break-all">
        Código: ${escapeHtml(ticketId)}
      </p>
      <p style="margin:10px 0 0;color:#ddd;font-size:11px">
        O QR Code deste ingresso está anexado a este e-mail.
      </p>
    </div>
  `;
}

function formatCpfDisplay(value) {
  const d = String(value || '').replace(/\D/g, '');
  if (d.length !== 11) return escapeHtml(value || '—');
  return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

function emailPosterInlineAttachment() {
  if (!fs.existsSync(POSTER_PATH)) {
    throw new Error(`Imagem da festa não encontrada: ${POSTER_PATH}`);
  }

  const posterBase64 = fs
    .readFileSync(POSTER_PATH)
    .toString('base64');

  return {
    filename: 'baile-da-madrid-background.png',
    contentType: 'image/png',
    content: posterBase64,
    contentId: 'baile-madrid-background@bailedamadrid'
  };
}

function ticketAttachments(tickets) {
  return tickets.map(t => {
    const ticketId = t.ticket_id || t.ticketId || '';
    const qrBase64 = t.qr_base64 || t.qrBase64 || '';

    if (!ticketId || !qrBase64) {
      throw new Error(`QR Code ausente para o ingresso ${ticketId || '(sem código)'}.`);
    }

    return {
      filename: `qr-${ticketId}.png`,
      contentType: 'image/png',
      content: qrBase64
    };
  });
}

/* ========================================================
   GERAR INGRESSOS E ENVIAR E-MAIL
   ======================================================== */

async function fulfillLocked(orderId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const orderResult = await client.query(
      `
        SELECT
          order_id AS "orderId",
          payment_id AS "paymentId",
          status,
          total,
          buyer_name AS "buyerName",
          buyer_email AS "buyerEmail",
          buyer_cpf AS "buyerCpf",
          buyer_phone AS "buyerPhone",
          items,
          email_sent_at AS "emailSentAt",
          email_error AS "emailError"
        FROM orders
        WHERE order_id=$1
        FOR UPDATE
      `,
      [orderId]
    );

    const order = orderResult.rows[0];

    if (!order) {
      throw new Error('Compra não encontrada.');
    }

    if (order.status !== 'approved') {
      await client.query('COMMIT');
      return order;
    }

    const existing = await client.query(
      `SELECT * FROM tickets WHERE order_id=$1 ORDER BY created_at ASC`,
      [orderId]
    );

    const expected = totalTicketCount(order);

    if (existing.rowCount < expected) {
      const existingCount = existing.rowCount;
      let index = existingCount;

      for (const item of order.items || []) {
        const batch = batches[item.id];

        if (!batch) {
          throw new Error(`Lote inválido: ${item.id}`);
        }

        for (let q = 0; q < Number(item.quantity); q++) {
          if (index >= expected) break;

          const ticketId = makeTicketCode();
          const token = makeTicketToken();
          const tokenHash = hashToken(token);

          const qrPayload = ticketPublicUrl(ticketId, token);
          const qrBase64 = await QRCode.toDataURL(qrPayload, {
            width: 700,
            margin: 2,
            errorCorrectionLevel: 'M'
          });

          const cleanBase64 = qrBase64.replace(
            /^data:image\/png;base64,/,
            ''
          );

          await client.query(
            `
              INSERT INTO tickets(
                ticket_id,
                order_id,
                token_hash,
                batch_id,
                batch_name,
                unit_price,
                buyer_name,
                buyer_email,
                qr_base64
              )
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
            `,
            [
              ticketId,
              orderId,
              tokenHash,
              item.id,
              batch.name,
              batch.price,
              order.buyerName,
              order.buyerEmail,
              cleanBase64
            ]
          );

          index++;
        }
      }
    }

    await client.query('COMMIT');

    const freshOrder = await getOrder(orderId);
    const tickets = await getTickets(orderId);

    if (tickets.length < expected) {
      throw new Error(
        `Ingressos incompletos: ${tickets.length}/${expected}.`
      );
    }

    if (!gmailReady()) {
      await db(
        `
          UPDATE orders
          SET email_error=$1, updated_at=NOW()
          WHERE order_id=$2
        `,
        ['Gmail API não configurada.', orderId]
      );

      return await getOrder(orderId);
    }

    if (!freshOrder.emailSentAt) {
      try {
        await sendGmail({
          to: freshOrder.buyer.email,
          subject: `Seu ingresso — ${EVENT_NAME}`,
          text:
            `🔥 INGRESSO CONFIRMADO! 🔥\n\n` +
            `Fala, ${freshOrder.buyer.name}! 😎\n\n` +
            `Seu pagamento foi aprovado e seu ingresso para ${EVENT_NAME} está garantido! 🕺💃🔥\n\n` +
            `🎟️ Seu QR Code está anexado neste e-mail.\n` +
            `Guarde ele e apresente na entrada no dia do baile.\n\n` +
            `🔥 Agora é só preparar o look, chamar a tropa e partir pro baile!\n\n` +
            `BAILE DA MADRID 2.0 🚀🔥\n` +
            `Vai ser daquele jeito! 😈🎶\n\n` +
            `Pedido: ${freshOrder.orderId}\n\n` +
            `Até o baile! 🥳🔥`,
          attachments: ticketAttachments(tickets),
          html: `
            <div style="margin:0;padding:0;background:#050505;font-family:Arial,sans-serif;color:#fff">
              <div style="width:100%;max-width:680px;margin:0 auto;padding:30px 20px 36px;background:#090909;color:#fff;text-align:center">
                <div style="padding:24px 16px;background:#111;border:1px solid rgba(255,255,255,.15);border-radius:18px">
                  <div style="font-size:28px;font-weight:900;letter-spacing:1px">🔥 INGRESSO CONFIRMADO! 🔥</div>
                  <h1 style="margin:14px 0 8px;font-size:34px;line-height:1.15;color:#fff">${escapeHtml(EVENT_NAME)}</h1>
                  <p style="margin:0;color:#fff;font-size:19px;line-height:1.5">Fala, ${escapeHtml(freshOrder.buyer.name)}! 😎</p>
                  <p style="margin:10px 0 0;color:#fff;font-size:17px;line-height:1.55">Seu pagamento foi aprovado e seu ingresso está garantido! 🕺💃🔥</p>
                </div>

                ${tickets.map(ticketHtml).join('')}

                <div style="margin-top:18px;padding:22px 18px;background:#111;border-radius:16px;color:#fff;font-size:16px;line-height:1.65;text-align:left">
                  <p style="margin:0 0 14px"><strong>🎟️ Seu QR Code está anexado neste e-mail.</strong></p>
                  <p style="margin:0 0 14px">Guarde ele e apresente na entrada no dia do baile.</p>
                  <p style="margin:0 0 14px">🔥 Agora é só preparar o look, chamar a tropa e partir pro baile!</p>
                  <p style="margin:0 0 14px;text-align:center;font-size:20px;font-weight:900">BAILE DA MADRID 2.0 🚀🔥</p>
                  <p style="margin:0 0 14px;text-align:center;font-size:18px;font-weight:800">Vai ser daquele jeito! 😈🎶</p>
                  <p style="margin:0"><strong>Pedido:</strong> ${escapeHtml(freshOrder.orderId)}</p>
                </div>

                <p style="margin:22px 0 0;color:#eee;font-size:14px">Até o baile! 🥳🔥</p>
              </div>
            </div>
          `
        });

        await db(
          `
            UPDATE orders
            SET
              email_sent_at=NOW(),
              email_error=NULL,
              updated_at=NOW()
            WHERE order_id=$1
          `,
          [orderId]
        );
      } catch (emailError) {
        console.error('Erro ao enviar ingresso:', emailError);

        await db(
          `
            UPDATE orders
            SET
              email_error=$1,
              updated_at=NOW()
            WHERE order_id=$2
          `,
          [String(emailError.message || emailError), orderId]
        );
      }
    }

    return await getOrder(orderId);
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    throw e;
  } finally {
    client.release();
  }
}

/* ========================================================
   TESTE GMAIL
   ======================================================== */

app.get('/api/admin/test-smtp', requireAdmin, async (req, res) => {
  try {
    if (!gmailReady()) {
      return res.status(500).json({
        ok: false,
        error: 'Gmail API não configurada. Verifique as variáveis GMAIL_*.'
      });
    }

    const to = String(req.query.to || '').trim();

    if (!to) {
      return res.json({
        ok: true,
        provider: 'Gmail API',
        message:
          'Gmail API configurada. Informe ?to=EMAIL para enviar o teste.',
        from: GMAIL_USER
      });
    }

    const info = await sendGmail({
      to,
      subject: `Teste de e-mail — ${EVENT_NAME}`,
      text: 'Este é um teste da Gmail API.',
      html: `
        <div style="font-family:Arial,sans-serif;padding:30px">
          <h2>Gmail API funcionando!</h2>
          <p>Este é um teste do sistema de e-mails do ${escapeHtml(EVENT_NAME)}.</p>
        </div>
      `
    });

    res.json({
      ok: true,
      provider: 'Gmail API',
      message: 'E-mail de teste enviado com sucesso.',
      id: info.id || null,
      from: GMAIL_USER,
      to
    });
  } catch (e) {
    console.error('Erro no teste Gmail:', e);

    res.status(500).json({
      ok: false,
      error: e.message || 'Falha na Gmail API.'
    });
  }
});

/* ========================================================
   CRIAR PIX
   ======================================================== */

app.post('/api/create-pix', async (req, res) => {
  try {
    const { buyer, items } = req.body || {};

    const name = String(buyer?.name || '').trim();
    const email = String(buyer?.email || '').trim();
    const phone = String(buyer?.phone || '').replace(/\D/g, '');
    const cpf = cleanCPF(buyer?.cpf);

    if (!name || !email || cpf.length !== 11) {
      return res.status(400).json({
        error: 'Informe nome, e-mail e CPF válidos.'
      });
    }

    if (phone.length !== 11) {
      return res.status(400).json({
        error: 'Informe um telefone válido.'
      });
    }

    const { normalized, total } = calculateItems(items);
    const orderId = crypto.randomUUID();
    const { first_name, last_name } = splitName(name);

    const body = {
      transaction_amount: Number(total.toFixed(2)),
      description:
        `${EVENT_NAME} - ${normalized.map(
          i => `${i.quantity}x ${i.name}`
        ).join(', ')}`,
      payment_method_id: 'pix',
      external_reference: orderId,
      payer: {
        email,
        first_name,
        last_name,
        identification: {
          type: 'CPF',
          number: cpf
        }
      }
    };

    if (PUBLIC_BASE_URL) {
      body.notification_url =
        `${PUBLIC_BASE_URL}/api/mercadopago/webhook`;
    }

    const payment = await mpRequest(
      'https://api.mercadopago.com/v1/payments',
      {
        method: 'POST',
        headers: {
          'X-Idempotency-Key': crypto.randomUUID()
        },
        body: JSON.stringify(body)
      }
    );

    const tx = payment.point_of_interaction?.transaction_data;

    if (!tx?.qr_code || !tx?.qr_code_base64) {
      throw new Error('Mercado Pago não retornou o QR Code PIX.');
    }

    await db(
      `
        INSERT INTO orders(
          order_id,
          payment_id,
          status,
          total,
          buyer_name,
          buyer_email,
          buyer_cpf,
          buyer_phone,
          items
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        orderId,
        String(payment.id),
        payment.status || 'pending',
        total,
        name,
        email,
        cpf,
        phone,
        JSON.stringify(normalized)
      ]
    );

    res.json({
      orderId,
      paymentId: String(payment.id),
      status: payment.status,
      qrCode: tx.qr_code,
      qrCodeBase64: tx.qr_code_base64
    });
  } catch (e) {
    console.error('Erro criar PIX:', e);

    res.status(400).json({
      error: e.message || 'Não foi possível gerar o PIX.'
    });
  }
});

/* ========================================================
   CRIAR PAGAMENTO COM CARTÃO
   ======================================================== */

app.post('/api/create-card-payment', async (req, res) => {
  try {
    const {
      buyer,
      items,
      token,
      paymentMethodId,
      issuerId,
      installments
    } = req.body || {};

    const name = String(buyer?.name || '').trim();
    const email = String(buyer?.email || '').trim();
    const phone = String(buyer?.phone || '').replace(/\D/g, '');
    const cpf = cleanCPF(buyer?.cpf);
    const cardToken = String(token || '').trim();
    const methodId = String(paymentMethodId || '').trim();
    const parsedIssuerId =
      issuerId ? String(issuerId) : undefined;
    const parsedInstallments = Number(installments || 1);

    if (!name || !email || cpf.length !== 11) {
      return res.status(400).json({
        error: 'Informe nome, e-mail e CPF válidos.'
      });
    }

    if (phone.length !== 11) {
      return res.status(400).json({
        error: 'Informe um telefone válido.'
      });
    }

    if (!cardToken || !methodId) {
      return res.status(400).json({
        error:
          'Não foi possível tokenizar o cartão. Verifique os dados.'
      });
    }

    if (
      !Number.isInteger(parsedInstallments) ||
      parsedInstallments < 1 ||
      parsedInstallments > 24
    ) {
      return res.status(400).json({
        error: 'Quantidade de parcelas inválida.'
      });
    }

    const { normalized, total } = calculateItems(items);
    const orderId = crypto.randomUUID();
    const { first_name, last_name } = splitName(name);

    const body = {
      transaction_amount: Number(total.toFixed(2)),
      description:
        `${EVENT_NAME} - ${normalized.map(
          i => `${i.quantity}x ${i.name}`
        ).join(', ')}`,
      payment_method_id: methodId,
      token: cardToken,
      installments: parsedInstallments,
      external_reference: orderId,
      payer: {
        email,
        first_name,
        last_name,
        identification: {
          type: 'CPF',
          number: cpf
        }
      }
    };

    if (parsedIssuerId) {
      body.issuer_id = parsedIssuerId;
    }

    if (PUBLIC_BASE_URL) {
      body.notification_url =
        `${PUBLIC_BASE_URL}/api/mercadopago/webhook`;
    }

    const payment = await mpRequest(
      'https://api.mercadopago.com/v1/payments',
      {
        method: 'POST',
        headers: {
          'X-Idempotency-Key': crypto.randomUUID()
        },
        body: JSON.stringify(body)
      }
    );

    await db(
      `
        INSERT INTO orders(
          order_id,
          payment_id,
          status,
          total,
          buyer_name,
          buyer_email,
          buyer_cpf,
          buyer_phone,
          items
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        orderId,
        String(payment.id),
        payment.status || 'pending',
        total,
        name,
        email,
        cpf,
        phone,
        JSON.stringify(normalized)
      ]
    );

    if (payment.status === 'approved') {
      await fulfillLocked(orderId);
    }

    const finalOrder = await getOrder(orderId);

    res.json({
      orderId,
      paymentId: String(payment.id),
      status: finalOrder?.status || payment.status,
      statusDetail: payment.status_detail || null
    });
  } catch (e) {
    console.error('Erro pagamento cartão:', e);

    res.status(400).json({
      error:
        e.message ||
        'Não foi possível processar o pagamento com cartão.'
    });
  }
});

/* ========================================================
   STATUS DO PAGAMENTO
   ======================================================== */

app.get('/api/payment-status/:orderId', async (req, res) => {
  try {
    const order = await getOrder(req.params.orderId);

    if (!order) {
      return res.status(404).json({
        error: 'Compra não encontrada.'
      });
    }

    const payment = await mpRequest(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(
        order.paymentId
      )}`
    );

    await db(
      `
        UPDATE orders
        SET status=$1, updated_at=NOW()
        WHERE order_id=$2
      `,
      [
        payment.status || order.status,
        order.orderId
      ]
    );

    const finalOrder =
      payment.status === 'approved'
        ? await fulfillLocked(order.orderId)
        : await getOrder(order.orderId);

    const ticketCount = await countTickets(order.orderId);

    res.json({
      status: finalOrder.status,
      paymentId: finalOrder.paymentId,
      ticketsReady:
        ticketCount === totalTicketCount(finalOrder),
      emailSent: Boolean(finalOrder.emailSentAt),
      emailError: finalOrder.emailError || null
    });
  } catch (e) {
    console.error('Erro status pagamento:', e);

    res.status(500).json({
      error:
        e.message ||
        'Não foi possível consultar o pagamento.'
    });
  }
});

/* ========================================================
   WEBHOOK MERCADO PAGO
   ======================================================== */

app.post('/api/mercadopago/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const paymentId =
      req.body?.data?.id ||
      req.query?.id ||
      req.body?.id;

    if (!paymentId) return;

    const payment = await mpRequest(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(
        paymentId
      )}`
    );

    const orderId = payment.external_reference;

    if (!orderId) return;

    await db(
      `
        UPDATE orders
        SET status=$1, updated_at=NOW()
        WHERE order_id=$2
      `,
      [payment.status, orderId]
    );

    if (payment.status === 'approved') {
      await fulfillLocked(orderId);
    }
  } catch (e) {
    console.error('Webhook Mercado Pago:', e);
  }
});

/* ========================================================
   MEUS INGRESSOS — CONSULTA DO CLIENTE
   ======================================================== */
app.get('/api/my-tickets', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    const cpf = String(req.query.cpf || '').replace(/\D/g, '');

    if (!email || !email.includes('@') || cpf.length !== 11) {
      return res.status(400).json({ error: 'Informe o e-mail e o CPF usados na compra.' });
    }

    const orders = await db(
      `SELECT order_id, buyer_name, buyer_email, buyer_cpf, status
       FROM orders
       WHERE LOWER(buyer_email)=LOWER($1)
         AND REGEXP_REPLACE(buyer_cpf, '\\D', '', 'g')=$2
         AND status='approved'
       ORDER BY created_at DESC`,
      [email, cpf]
    );

    if (!orders.rows.length) {
      return res.status(404).json({ error: 'Nenhuma compra aprovada encontrada para esses dados.' });
    }

    const tickets = [];
    for (const order of orders.rows) {
      const rows = await getTickets(order.order_id);
      for (const t of rows) {
        tickets.push({
          ticketId: t.ticket_id,
          orderId: t.order_id,
          batchName: t.batch_name,
          unitPrice: t.unit_price,
          buyerName: t.buyer_name,
          usedAt: t.used_at,
          qrUrl: `/api/tickets/qr/${encodeURIComponent(t.ticket_id)}.png`
        });
      }
    }

    return res.json({ buyerName: orders.rows[0].buyer_name, tickets });
  } catch (e) {
    console.error('Erro ao consultar meus ingressos:', e);
    return res.status(500).json({ error: 'Não foi possível carregar seus ingressos.' });
  }
});

/* ========================================================
   QR CODE DO INGRESSO
   ======================================================== */

app.get('/api/tickets/qr/:ticketId.png', async (req, res) => {
  try {
    const ticketId = String(req.params.ticketId || '').trim();

    if (!/^BMD2-[A-F0-9]{10}$/i.test(ticketId)) {
      return res.status(400).send('QR inválido.');
    }

    const r = await db(
      `
        SELECT qr_base64
        FROM tickets
        WHERE UPPER(ticket_id)=UPPER($1)
        LIMIT 1
      `,
      [ticketId]
    );

    const base64 = r.rows[0]?.qr_base64;

    if (!base64) {
      return res.status(404).send('QR não encontrado.');
    }

    const buffer = Buffer.from(base64, 'base64');

    res.set({
      'Content-Type': 'image/png',
      'Content-Length': String(buffer.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff'
    });

    return res.end(buffer);
  } catch (e) {
    console.error('Erro ao entregar QR:', e);

    return res.status(500).send(
      'Não foi possível carregar o QR.'
    );
  }
});

/* ========================================================
   VALIDAÇÃO DO INGRESSO
   ======================================================== */

async function consumeTicketToken(rawToken) {
  const token = String(rawToken || '').trim();

  if (!token) {
    return {
      status: 400,
      body: {
        valid: false,
        error: 'QR Code inválido.'
      }
    };
  }

  const h = hashToken(token);

  const r = await db(
    `
      SELECT
        t.*,
        o.status AS order_status,
        o.buyer_cpf AS buyer_cpf
      FROM tickets t
      JOIN orders o ON o.order_id=t.order_id
      WHERE t.token_hash=$1
    `,
    [h]
  );

  const t = r.rows[0];

  if (!t) {
    return {
      status: 404,
      body: {
        valid: false,
        error: 'Ingresso não encontrado.'
      }
    };
  }

  if (t.order_status !== 'approved') {
    return {
      status: 400,
      body: {
        valid: false,
        error: 'Pagamento não aprovado.'
      }
    };
  }

  const used = await db(
    `
      UPDATE tickets
      SET used_at=NOW()
      WHERE ticket_id=$1
        AND used_at IS NULL
      RETURNING used_at
    `,
    [t.ticket_id]
  );

  if (!used.rows[0]) {
    const fresh = await db(
      `
        SELECT t.ticket_id,t.batch_name,t.buyer_name,o.buyer_cpf,t.used_at
        FROM tickets t
        JOIN orders o ON o.order_id=t.order_id
        WHERE t.ticket_id=$1
      `,
      [t.ticket_id]
    );

    const already = fresh.rows[0];

    return {
      status: 409,
      body: {
        valid: false,
        used: true,
        error: 'Este ingresso já foi utilizado.',
        ticket: already
          ? {
              ticketId: already.ticket_id,
              batchName: already.batch_name,
              buyerName: already.buyer_name,
              buyerCpf: already.buyer_cpf,
              usedAt: already.used_at
            }
          : undefined
      }
    };
  }

  return {
    status: 200,
    body: {
      valid: true,
      used: false,
      message: 'Entrada liberada.',
      ticket: {
        ticketId: t.ticket_id,
        batchName: t.batch_name,
        buyerName: t.buyer_name,
        buyerCpf: t.buyer_cpf,
        usedAt: used.rows[0].used_at
      }
    }
  };
}

app.get('/api/tickets/scan', async (req, res) => {
  try {
    const result = await consumeTicketToken(req.query.ticket);

    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error('Erro na validação pública:', e);

    return res.status(500).json({
      valid: false,
      error: 'Não foi possível validar o ingresso.'
    });
  }
});

app.post('/api/tickets/validate', requireAdmin, async (req, res) => {
  try {
    const result = await consumeTicketToken(req.body?.token);

    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error('Erro ao validar ingresso:', e);

    return res.status(500).json({
      valid: false,
      error:
        e.message ||
        'Não foi possível validar o ingresso.'
    });
  }
});

/* ========================================================
   HISTÓRICO DA PORTARIA
   ======================================================== */

app.get('/api/tickets/history', requireAdmin, async (req, res) => {
  try {
    const limitRaw = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 100;
    const search = String(req.query.search || '').trim();

    const r = await db(
      `
        SELECT
          t.ticket_id AS "ticketId",
          t.batch_name AS "batchName",
          t.buyer_name AS "buyerName",
          o.buyer_cpf AS "buyerCpf",
          t.used_at AS "usedAt"
        FROM tickets t
        JOIN orders o ON o.order_id=t.order_id
        WHERE t.used_at IS NOT NULL
          AND (
            $1 = ''
            OR t.buyer_name ILIKE '%' || $1 || '%'
            OR o.buyer_cpf ILIKE '%' || $1 || '%'
            OR t.ticket_id ILIKE '%' || $1 || '%'
            OR t.batch_name ILIKE '%' || $1 || '%'
          )
        ORDER BY t.used_at DESC, t.ticket_id DESC
        LIMIT $2
      `,
      [search, limit]
    );

    return res.json({ entries: r.rows, count: r.rows.length });
  } catch (e) {
    console.error('Erro ao carregar histórico da portaria:', e);
    return res.status(500).json({ error: e.message || 'Não foi possível carregar o histórico.' });
  }
});

/* ========================================================
   REENVIAR INGRESSO
   ======================================================== */

app.post('/api/tickets/resend/:orderId', requireAdmin, async (req, res) => {
  try {
    const order = await getOrder(req.params.orderId);

    if (!order) {
      return res.status(404).json({
        error: 'Compra não encontrada.'
      });
    }

    if (order.status !== 'approved') {
      return res.status(400).json({
        error: 'Pagamento ainda não aprovado.'
      });
    }

    let tickets = await getTickets(order.orderId);

    if (tickets.length !== totalTicketCount(order)) {
      await fulfillLocked(order.orderId);
    }

    const fresh = await getOrder(order.orderId);
    tickets = await getTickets(order.orderId);

    if (!gmailReady()) {
      throw new Error('Gmail API não configurada.');
    }

    await sendGmail({
      to: fresh.buyer.email,
      subject: `Reenvio — ${EVENT_NAME}`,
      text:
        `🔥 SEUS INGRESSOS ESTÃO DE VOLTA! 🔥\n\n` +
        `Fala, ${fresh.buyer.name}! 😎\n\n` +
        `Estamos reenviando seus ingressos para ${EVENT_NAME}. 🕺💃🔥\n\n` +
        `🎟️ Os QR Codes estão anexados neste e-mail.\n` +
        `Guarde eles e apresente o QR Code correspondente na entrada.\n\n` +
        `🔥 Prepare o look, chama a tropa e partiu baile!\n\n` +
        `BAILE DA MADRID 2.0 🚀🔥\n` +
        `Vai ser daquele jeito! 😈🎶\n\n` +
        `Pedido: ${fresh.orderId}\n\n` +
        `Até o baile! 🥳🔥`,
      attachments: ticketAttachments(tickets),
      html: `
        <div style="margin:0;padding:0;background:#050505;font-family:Arial,sans-serif;color:#fff">
          <div style="width:100%;max-width:680px;margin:0 auto;padding:30px 20px 36px;background:#090909;color:#fff;text-align:center">
            <div style="padding:24px 16px;background:#111;border:1px solid rgba(255,255,255,.15);border-radius:18px">
              <div style="font-size:25px;font-weight:900">🔥 SEUS INGRESSOS ESTÃO DE VOLTA! 🔥</div>
              <h1 style="margin:14px 0 8px;font-size:34px;line-height:1.15;color:#fff">${escapeHtml(EVENT_NAME)}</h1>
              <p style="margin:0;color:#fff;font-size:18px;line-height:1.55">Fala, ${escapeHtml(fresh.buyer.name)}! 😎</p>
            </div>
            ${tickets.map(ticketHtml).join('')}
            <div style="margin-top:18px;padding:22px 18px;background:#111;border-radius:16px;color:#fff;font-size:16px;line-height:1.65;text-align:left">
              <p style="margin:0 0 14px"><strong>🎟️ Os QR Codes estão anexados neste e-mail.</strong></p>
              <p style="margin:0 0 14px">Guarde eles e apresente o QR Code correspondente na entrada.</p>
              <p style="margin:0 0 14px">🔥 Prepare o look, chama a tropa e partiu baile!</p>
              <p style="margin:0 0 14px;text-align:center;font-size:20px;font-weight:900">BAILE DA MADRID 2.0 🚀🔥</p>
              <p style="margin:0 0 14px;text-align:center;font-size:18px;font-weight:800">Vai ser daquele jeito! 😈🎶</p>
              <p style="margin:0"><strong>Pedido:</strong> ${escapeHtml(fresh.orderId)}</p>
            </div>
            <p style="margin:22px 0 0;color:#eee;font-size:14px">Até o baile! 🥳🔥</p>
          </div>
        </div>
      `
    });

    await db(
      `
        UPDATE orders
        SET
          email_sent_at=NOW(),
          email_error=NULL,
          updated_at=NOW()
        WHERE order_id=$1
      `,
      [order.orderId]
    );

    res.json({
      ok: true,
      message: 'Ingressos reenviados.'
    });
  } catch (e) {
    console.error('Erro ao reenviar:', e);

    res.status(500).json({
      error:
        e.message ||
        'Não foi possível reenviar os ingressos.'
    });
  }
});

/* ========================================================
   ESTATÍSTICAS
   ======================================================== */

app.get('/api/tickets/stats', requireAdmin, async (req, res) => {
  try {
    const a = await db(
      `
        SELECT COUNT(*)::int AS n
        FROM orders
        WHERE status='approved'
      `
    );

    const s = await db(
      `
        SELECT
          COUNT(*)::int AS n,
          COUNT(*) FILTER(
            WHERE used_at IS NOT NULL
          )::int AS used
        FROM tickets
      `
    );

    const sold = s.rows[0].n;
    const used = s.rows[0].used;

    res.json({
      approvedOrders: a.rows[0].n,
      soldTickets: sold,
      usedTickets: used,
      availableTickets: Math.max(0, sold - used)
    });
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

/* ========================================================
   PEDIDOS DO PAINEL ADMINISTRATIVO
   ======================================================== */

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();

    const result = await db(
      status
        ? `
          SELECT
            order_id AS "orderId",
            payment_id AS "paymentId",
            status,
            total,
            buyer_name AS "buyerName",
            buyer_email AS "buyerEmail",
            buyer_cpf AS "buyerCpf",
            buyer_phone AS "buyerPhone",
            items,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM orders
          WHERE status = $1
          ORDER BY created_at DESC
        `
        : `
          SELECT
            order_id AS "orderId",
            payment_id AS "paymentId",
            status,
            total,
            buyer_name AS "buyerName",
            buyer_email AS "buyerEmail",
            buyer_cpf AS "buyerCpf",
            buyer_phone AS "buyerPhone",
            items,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM orders
          ORDER BY created_at DESC
        `,
      status ? [status] : []
    );

    const orders = [];

    for (const row of result.rows) {
      const tickets = await getTickets(row.orderId);

      orders.push({
        orderId: row.orderId,
        paymentId: row.paymentId,
        status: row.status,
        total: Number(row.total),
        buyer: {
          name: row.buyerName,
          email: row.buyerEmail,
          cpf: row.buyerCpf,
          phone: row.buyerPhone
        },
        items: row.items || [],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        tickets: tickets.map(t => ({
          ticketId: t.ticket_id,
          orderId: t.order_id,
          batchId: t.batch_id,
          batchName: t.batch_name,
          unitPrice: Number(t.unit_price),
          usedAt: t.used_at
        }))
      });
    }

    res.json({
      ok: true,
      orders
    });
  } catch (e) {
    console.error('Erro listar pedidos administrativos:', e);
    res.status(500).json({
      error: e.message || 'Não foi possível carregar os compradores.'
    });
  }
});

app.get('/api/admin/sales-by-batch', requireAdmin, async (req, res) => {
  try {
    const result = await db(`
      SELECT
        t.batch_name AS "batchName",
        COUNT(*)::int AS "soldTickets",
        COALESCE(SUM(t.unit_price), 0)::numeric AS revenue,
        COUNT(*) FILTER (WHERE t.used_at IS NOT NULL)::int AS "usedTickets"
      FROM tickets t
      INNER JOIN orders o ON o.order_id = t.order_id
      WHERE o.status = 'approved'
      GROUP BY t.batch_id, t.batch_name
      ORDER BY MIN(t.created_at) ASC
    `);

    res.json({
      ok: true,
      sales: result.rows.map(row => ({
        batchName: row.batchName,
        soldTickets: Number(row.soldTickets),
        revenue: Number(row.revenue),
        usedTickets: Number(row.usedTickets)
      }))
    });
  } catch (e) {
    console.error('Erro vendas por lote:', e);
    res.status(500).json({
      error: e.message || 'Não foi possível carregar as vendas por lote.'
    });
  }
});

/* ========================================================
   COMPRA DE TESTE
   ======================================================== */

app.post('/api/admin/test-order', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};

    const name = String(
      body.name || 'Cliente de Teste'
    ).trim();

    const email = String(body.email || '').trim();

    const phone = String(
      body.phone || '61999999999'
    ).replace(/\D/g, '');

    const cpf = cleanCPF(
      body.cpf || '11144477735'
    );

    const batchId = String(
      body.batchId || 'pre'
    );

    if (!email) {
      return res.status(400).json({
        error:
          'Informe o e-mail que receberá o ingresso de teste.'
      });
    }

    if (!batches[batchId]) {
      return res.status(400).json({
        error: 'Tipo de ingresso de teste inválido.'
      });
    }

    if (cpf.length !== 11) {
      return res.status(400).json({
        error: 'CPF de teste inválido.'
      });
    }

    const orderId = `TEST-${crypto.randomUUID()}`;
    const paymentId = `TEST-PAY-${crypto.randomUUID()}`;

    const item = {
      id: batchId,
      name: batches[batchId].name,
      quantity: 1,
      unit_price: batches[batchId].price
    };

    await db(
      `
        INSERT INTO orders(
          order_id,
          payment_id,
          status,
          total,
          buyer_name,
          buyer_email,
          buyer_cpf,
          buyer_phone,
          items
        )
        VALUES($1,$2,'approved',$3,$4,$5,$6,$7,$8)
      `,
      [
        orderId,
        paymentId,
        batches[batchId].price,
        name,
        email,
        cpf,
        phone,
        JSON.stringify([item])
      ]
    );

    const fulfilled = await fulfillLocked(orderId);
    const tickets = await getTickets(orderId);

    res.json({
      ok: true,
      test: true,
      orderId,
      status: fulfilled.status,
      emailSent: Boolean(fulfilled.emailSentAt),
      emailError: fulfilled.emailError || null,
      tickets: tickets.map(t => ({
        ticketId: t.ticket_id,
        batchName: t.batch_name,
        usedAt: t.used_at
      }))
    });
  } catch (e) {
    console.error('Compra de teste:', e);

    res.status(500).json({
      error:
        e.message ||
        'Não foi possível criar a compra de teste.'
    });
  }
});

/* ========================================================
   TESTE ESPECÍFICO DE PIX
   ======================================================== */

app.post('/api/admin/test-pix-payment', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};

    const name = String(
      body.name || 'Cliente Teste PIX'
    ).trim();

    const email = String(body.email || '').trim();

    const phone = String(
      body.phone || '61999999999'
    ).replace(/\D/g, '');

    const cpf = cleanCPF(
      body.cpf || '11144477735'
    );

    const batchId = String(
      body.batchId || 'pre'
    );

    if (!email) {
      return res.status(400).json({
        error: 'Informe o e-mail que receberá o teste PIX.'
      });
    }

    if (!batches[batchId]) {
      return res.status(400).json({
        error: 'Tipo de ingresso PIX inválido.'
      });
    }

    if (cpf.length !== 11) {
      return res.status(400).json({
        error: 'CPF de teste inválido.'
      });
    }

    if (phone.length !== 11) {
      return res.status(400).json({
        error: 'Telefone de teste inválido.'
      });
    }

    /*
      Este endpoint é propositalmente um TESTE ADMINISTRATIVO.
      Ele não cria uma cobrança real no Mercado Pago e não movimenta dinheiro.
      O objetivo é testar exatamente a etapa posterior ao PIX aprovado:
      pedido aprovado -> ingresso -> QR Code -> Gmail.
    */

    const orderId = `TEST-PIX-${crypto.randomUUID()}`;
    const paymentId = `TEST-PIX-PAY-${crypto.randomUUID()}`;

    const item = {
      id: batchId,
      name: batches[batchId].name,
      quantity: 1,
      unit_price: batches[batchId].price
    };

    await db(
      `
        INSERT INTO orders(
          order_id,
          payment_id,
          status,
          total,
          buyer_name,
          buyer_email,
          buyer_cpf,
          buyer_phone,
          items
        )
        VALUES($1,$2,'approved',$3,$4,$5,$6,$7,$8)
      `,
      [
        orderId,
        paymentId,
        batches[batchId].price,
        name,
        email,
        cpf,
        phone,
        JSON.stringify([item])
      ]
    );

    const fulfilled = await fulfillLocked(orderId);
    const tickets = await getTickets(orderId);

    return res.json({
      ok: true,
      test: true,
      simulatedPayment: 'pix',
      paymentMethod: 'pix',
      paymentStatus: 'approved',
      orderId,
      paymentId,
      status: fulfilled.status,
      emailSent: Boolean(fulfilled.emailSentAt),
      emailError: fulfilled.emailError || null,
      tickets: tickets.map(t => ({
        ticketId: t.ticket_id,
        batchName: t.batch_name,
        usedAt: t.used_at
      }))
    });
  } catch (e) {
    console.error('Teste PIX:', e);

    return res.status(500).json({
      error:
        e.message ||
        'Não foi possível executar o teste de PIX.'
    });
  }
});

/* ========================================================
   TESTE ESPECÍFICO DE CARTÃO
   ======================================================== */

app.post('/api/admin/test-card-payment', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};

    const name = String(
      body.name || 'Cliente Teste Cartão'
    ).trim();

    const email = String(body.email || '').trim();

    const phone = String(
      body.phone || '61999999999'
    ).replace(/\D/g, '');

    const cpf = cleanCPF(
      body.cpf || '11144477735'
    );

    const batchId = String(
      body.batchId || 'pre'
    );

    if (!email) {
      return res.status(400).json({
        error:
          'Informe o e-mail que receberá o teste.'
      });
    }

    if (!batches[batchId]) {
      return res.status(400).json({
        error: 'Tipo de ingresso inválido.'
      });
    }

    const orderId = `TEST-CARD-${crypto.randomUUID()}`;
    const paymentId = `TEST-CARD-PAY-${crypto.randomUUID()}`;

    const item = {
      id: batchId,
      name: batches[batchId].name,
      quantity: 1,
      unit_price: batches[batchId].price
    };

    await db(
      `
        INSERT INTO orders(
          order_id,
          payment_id,
          status,
          total,
          buyer_name,
          buyer_email,
          buyer_cpf,
          buyer_phone,
          items
        )
        VALUES($1,$2,'approved',$3,$4,$5,$6,$7,$8)
      `,
      [
        orderId,
        paymentId,
        batches[batchId].price,
        name,
        email,
        cpf,
        phone,
        JSON.stringify([item])
      ]
    );

    const fulfilled = await fulfillLocked(orderId);
    const tickets = await getTickets(orderId);

    res.json({
      ok: true,
      test: true,
      simulatedPayment: 'card',
      paymentStatus: 'approved',
      orderId,
      emailSent: Boolean(fulfilled.emailSentAt),
      emailError: fulfilled.emailError || null,
      tickets: tickets.map(t => ({
        ticketId: t.ticket_id,
        batchName: t.batch_name,
        usedAt: t.used_at
      }))
    });
  } catch (e) {
    console.error('Teste cartão:', e);

    res.status(500).json({
      error:
        e.message ||
        'Não foi possível executar o teste de cartão.'
    });
  }
});

/* ========================================================
   APAGAR COMPRAS DE TESTE
   ======================================================== */

app.delete('/api/admin/test-orders', requireAdmin, async (req, res) => {
  try {
    const result = await db(
      `
        DELETE FROM orders
        WHERE order_id LIKE 'TEST-%'
        RETURNING order_id
      `
    );

    res.json({
      ok: true,
      deleted: result.rowCount
    });
  } catch (e) {
    console.error('Excluir testes:', e);

    res.status(500).json({
      error:
        e.message ||
        'Não foi possível excluir as compras de teste.'
    });
  }
});

/* ========================================================
   HEALTH CHECK
   ======================================================== */

app.get('/health', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({
        ok: false,
        database: false,
        gmail: gmailReady()
      });
    }

    await db('SELECT 1');

    res.json({
      ok: true,
      database: true,
      gmail: gmailReady(),
      mercadopago: Boolean(ACCESS_TOKEN)
    });
  } catch (e) {
    res.status(503).json({
      ok: false,
      database: false,
      gmail: gmailReady(),
      mercadopago: Boolean(ACCESS_TOKEN),
      error: e.message
    });
  }
});

/* ========================================================
   ROTA FINAL
   ======================================================== */

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ========================================================
   INICIAR SERVIDOR
   ======================================================== */

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(
        `${EVENT_NAME} em http://0.0.0.0:${PORT}`
      );

      console.log('E-mail: Gmail API');
      console.log(`GMAIL_USER: ${GMAIL_USER}`);
      console.log(`Gmail configurado: ${gmailReady()}`);
      console.log(`Mercado Pago configurado: ${Boolean(ACCESS_TOKEN)}`);
      console.log(`PostgreSQL configurado: ${Boolean(pool)}`);
    });
  })
  .catch(e => {
    console.error('Falha ao inicializar banco:', e);
    process.exit(1);
  });
