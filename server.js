const express = require('express');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const { google } = require('googleapis');

const app = express();

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

const PUBLIC_KEY = process.env.MP_PUBLIC_KEY || '';

const PUBLIC_BASE_URL =
  (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const ADMIN_TOKEN =
  process.env.ADMIN_TOKEN || '';

/* ========================================================
   GMAIL API / OAUTH2
   ======================================================== */

const GMAIL_CLIENT_ID =
  process.env.GMAIL_CLIENT_ID || '';

const GMAIL_CLIENT_SECRET =
  process.env.GMAIL_CLIENT_SECRET || '';

const GMAIL_REDIRECT_URI =
  process.env.GMAIL_REDIRECT_URI || '';

const GMAIL_USER =
  process.env.GMAIL_USER || '';

const GMAIL_REFRESH_TOKEN =
  process.env.GMAIL_REFRESH_TOKEN || '';

const EVENT_NAME =
  'Baile da Madrid 2.0';

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

  if (
    !GMAIL_CLIENT_ID ||
    !GMAIL_CLIENT_SECRET ||
    !GMAIL_REDIRECT_URI
  ) {
    throw new Error(
      'Credenciais da Gmail API não configuradas.'
    );
  }

  const oauth2Client =
    new google.auth.OAuth2(
      GMAIL_CLIENT_ID,
      GMAIL_CLIENT_SECRET,
      GMAIL_REDIRECT_URI
    );

  if (GMAIL_REFRESH_TOKEN) {

    oauth2Client.setCredentials({
      refresh_token:
        GMAIL_REFRESH_TOKEN
    });
  }

  return oauth2Client;
}

function getGmailService() {

  const auth =
    getGmailClient();

  return google.gmail({
    version: 'v1',
    auth
  });
}

function base64UrlEncode(str) {

  return Buffer
    .from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function createMimeMessage({
  from,
  to,
  subject,
  text,
  html,
  attachments = []
}) {

  const boundary =
    `mixed_${crypto.randomBytes(12).toString('hex')}`;

  const alternativeBoundary =
    `alternative_${crypto.randomBytes(12).toString('hex')}`;

  let message = '';

  message += `From: ${from}\r\n`;
  message += `To: ${to}\r\n`;
  message += `Subject: ${subject}\r\n`;
  message += `MIME-Version: 1.0\r\n`;
  message += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n`;
  message += `\r\n`;

  message += `--${boundary}\r\n`;
  message += `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"\r\n`;
  message += `\r\n`;

  message += `--${alternativeBoundary}\r\n`;
  message += `Content-Type: text/plain; charset="UTF-8"\r\n`;
  message += `Content-Transfer-Encoding: 8bit\r\n`;
  message += `\r\n`;
  message += `${text || ''}\r\n`;
  message += `\r\n`;

  message += `--${alternativeBoundary}\r\n`;
  message += `Content-Type: text/html; charset="UTF-8"\r\n`;
  message += `Content-Transfer-Encoding: 8bit\r\n`;
  message += `\r\n`;
  message += `${html || ''}\r\n`;
  message += `\r\n`;

  message += `--${alternativeBoundary}--\r\n`;
  message += `\r\n`;

  for (const attachment of attachments) {

    message += `--${boundary}\r\n`;
    message += `Content-Type: ${attachment.contentType}; name="${attachment.filename}"\r\n`;
    message += `Content-Disposition: inline; filename="${attachment.filename}"\r\n`;
    message += `Content-Transfer-Encoding: base64\r\n`;

    if (attachment.contentId) {

      message += `Content-ID: <${attachment.contentId}>\r\n`;
    }

    message += `\r\n`;

    const content =
      Buffer
        .from(attachment.content, 'base64')
        .toString('base64');

    for (
      let i = 0;
      i < content.length;
      i += 76
    ) {

      message +=
        content.substring(i, i + 76) +
        '\r\n';
    }

    message += `\r\n`;
  }

  message += `--${boundary}--\r\n`;

  return message;
}

async function sendGmail({
  to,
  subject,
  text,
  html,
  attachments = []
}) {

  if (!gmailReady()) {

    throw new Error(
      'Gmail API não está configurada. ' +
      'Verifique GMAIL_CLIENT_ID, ' +
      'GMAIL_CLIENT_SECRET, ' +
      'GMAIL_REDIRECT_URI, ' +
      'GMAIL_USER e GMAIL_REFRESH_TOKEN.'
    );
  }

  const gmail =
    getGmailService();

  const mime =
    createMimeMessage({

      from:
        GMAIL_USER,

      to,

      subject,

      text,

      html,

      attachments
    });

  const encoded =
    base64UrlEncode(mime);

  const result =
    await gmail.users.messages.send({

      userId: 'me',

      requestBody: {
        raw: encoded
      }

    });

  return result.data;
}

/* ========================================================
   AUTORIZAÇÃO GMAIL
   ======================================================== */

app.get(
  '/api/gmail/auth',
  (req, res) => {

    if (
      !GMAIL_CLIENT_ID ||
      !GMAIL_CLIENT_SECRET ||
      !GMAIL_REDIRECT_URI
    ) {

      return res.status(500).send(
        'Configure GMAIL_CLIENT_ID, ' +
        'GMAIL_CLIENT_SECRET e ' +
        'GMAIL_REDIRECT_URI no Render.'
      );
    }

    const oauth2Client =
      new google.auth.OAuth2(
        GMAIL_CLIENT_ID,
        GMAIL_CLIENT_SECRET,
        GMAIL_REDIRECT_URI
      );

    const url =
      oauth2Client.generateAuthUrl({

        access_type: 'offline',

        prompt: 'consent',

        scope: [
          'https://www.googleapis.com/auth/gmail.send'
        ]

      });

    res.redirect(url);
  }
);

app.get(
  '/api/gmail/oauth2callback',
  async (req, res) => {

    try {

      const code =
        String(
          req.query.code || ''
        ).trim();

      if (!code) {

        return res.status(400).send(
          'Código OAuth não recebido.'
        );
      }

      const oauth2Client =
        new google.auth.OAuth2(
          GMAIL_CLIENT_ID,
          GMAIL_CLIENT_SECRET,
          GMAIL_REDIRECT_URI
        );

      const { tokens } =
        await oauth2Client.getToken(code);

      if (!tokens.refresh_token) {

        return res.status(500).send(
          'O Google não retornou um refresh token. ' +
          'Tente novamente usando /api/gmail/auth.'
        );
      }

      res.send(`
        <!doctype html>
        <html lang="pt-BR">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport"
            content="width=device-width,initial-scale=1">
          <title>Gmail autorizado</title>
          <style>
            body{
              margin:0;
              padding:40px 20px;
              background:#070707;
              color:#fff;
              font-family:Arial,sans-serif;
            }
            .box{
              max-width:700px;
              margin:auto;
              background:#111;
              border:1px solid #333;
              border-radius:16px;
              padding:25px;
            }
            code{
              display:block;
              word-break:break-all;
              background:#000;
              padding:15px;
              border-radius:10px;
              margin-top:15px;
            }
          </style>
        </head>
        <body>
          <div class="box">

            <h2>
              Gmail autorizado com sucesso!
            </h2>

            <p>
              Copie o Refresh Token abaixo e coloque
              no Render como:
            </p>

            <strong>
              GMAIL_REFRESH_TOKEN
            </strong>

            <code>${tokens.refresh_token}</code>

            <p>
              Depois de salvar a variável no Render,
              faça um novo deploy.
            </p>

          </div>
        </body>
        </html>
      `);

    } catch (e) {

      console.error(
        'Erro OAuth Gmail:',
        e
      );

      res.status(500).send(
        `Erro ao autorizar Gmail: ${
          e.message || e
        }`
      );
    }
  }
);

/* ========================================================
   TESTE GMAIL API
   ======================================================== */

app.get(
  '/api/admin/test-smtp',
  requireAdmin,
  async (req, res) => {

    try {

      if (!gmailReady()) {

        return res.status(500).json({

          ok: false,

          error:
            'Gmail API não configurada. ' +
            'Verifique as variáveis GMAIL_*.'
        });
      }

      const to =
        String(
          req.query.to || ''
        ).trim();

      if (!to) {

        return res.json({

          ok: true,

          provider:
            'Gmail API',

          message:
            'Gmail API configurada. ' +
            'Informe ?to=EMAIL para enviar o teste.',

          from:
            GMAIL_USER
        });
      }

      const info =
        await sendGmail({

          to,

          subject:
            'Teste de e-mail — Baile da Madrid 2.0',

          text:
            'Este é um teste da Gmail API.',

          html: `
            <div style="
              font-family:Arial,sans-serif;
              padding:30px
            ">

              <h2>
                Gmail API funcionando!
              </h2>

              <p>
                Este é um teste do sistema
                de e-mails do
                ${EVENT_NAME}.
              </p>

            </div>
          `
        });

      res.json({

        ok: true,

        provider:
          'Gmail API',

        message:
          'E-mail de teste enviado com sucesso.',

        id:
          info.id || null,

        from:
          GMAIL_USER,

        to
      });

    } catch (e) {

      console.error(
        'Erro no teste Gmail:',
        e
      );

      res.status(500).json({

        ok: false,

        error:
          e.message ||
          'Falha na Gmail API.'
      });
    }
  }
);
/* ========================================================
   CONFIGURAÇÕES DO EVENTO
   ======================================================== */

const batches = {

  pre: {
    name: 'Pré-Venda',
    price: 10
  },

  lote1: {
    name: '1º Lote',
    price: 20
  },

  lote2: {
    name: '2º Lote',
    price: 25
  },

  lote3: {
    name: '3º Lote',
    price: 30
  },

  vip: {
    name: 'Área VIP',
    price: 70
  }

};

/* ========================================================
   BANCO DE DADOS
   ======================================================== */

if (!process.env.DATABASE_URL) {

  console.warn(
    'DATABASE_URL não configurado.'
  );

}

const pool =
  process.env.DATABASE_URL

    ? new Pool({

        connectionString:
          process.env.DATABASE_URL,

        ssl: {
          rejectUnauthorized: false
        },

        max: 5

      })

    : null;

async function db(
  query,
  params = []
) {

  if (!pool) {

    throw new Error(
      'DATABASE_URL não configurado.'
    );

  }

  return pool.query(
    query,
    params
  );

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

      created_at
        TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at
        TIMESTAMPTZ,

      email_sent_at
        TIMESTAMPTZ,

      email_error TEXT

    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS tickets(

      ticket_id TEXT PRIMARY KEY,

      order_id TEXT NOT NULL
        REFERENCES orders(order_id)
        ON DELETE CASCADE,

      token_hash TEXT UNIQUE NOT NULL,

      batch_id TEXT NOT NULL,

      batch_name TEXT NOT NULL,

      unit_price NUMERIC(10,2) NOT NULL,

      buyer_name TEXT NOT NULL,

      buyer_email TEXT NOT NULL,

      qr_base64 TEXT NOT NULL,

      created_at
        TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      used_at TIMESTAMPTZ

    )
  `);

  await db(`
    CREATE INDEX IF NOT EXISTS
    idx_tickets_token_hash
    ON tickets(token_hash)
  `);

  await db(`
    CREATE INDEX IF NOT EXISTS
    idx_tickets_order_id
    ON tickets(order_id)
  `);

  await db(`
    CREATE INDEX IF NOT EXISTS
    idx_tickets_ticket_id
    ON tickets(ticket_id)
  `);

}

/* ========================================================
   FUNÇÕES AUXILIARES
   ======================================================== */

function cleanCPF(v) {

  return String(v || '')
    .replace(/\D/g, '');

}

function splitName(name) {

  const p =
    String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  return {

    first_name:
      p.shift() || 'Cliente',

    last_name:
      p.join(' ') ||
      'Baile Madrid'

  };

}

function calculateItems(items) {

  if (
    !Array.isArray(items) ||
    !items.length
  ) {

    throw new Error(
      'Nenhum ingresso selecionado.'
    );

  }

  let total = 0;

  const normalized = [];

  for (
    const item
    of items
  ) {

    const batch =
      batches[item.id];

    const quantity =
      Number(item.quantity);

    if (
      !batch ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 10
    ) {

      throw new Error(
        'Ingresso ou quantidade inválida.'
      );

    }

    total +=
      batch.price * quantity;

    normalized.push({

      id:
        item.id,

      name:
        batch.name,

      quantity,

      unit_price:
        batch.price

    });

  }

  if (
    normalized.reduce(
      (s, i) =>
        s + i.quantity,
      0
    ) > 10
  ) {

    throw new Error(
      'Limite máximo de 10 ingressos por compra.'
    );

  }

  return {

    normalized,

    total

  };

}

function totalTicketCount(order) {

  return (order.items || [])
    .reduce(
      (sum, item) =>
        sum +
        Number(
          item.quantity || 0
        ),
      0
    );

}

function makeTicketCode() {

  return `BMD2-${
    crypto
      .randomBytes(5)
      .toString('hex')
      .toUpperCase()
  }`;

}

function makeTicketToken() {

  return crypto
    .randomBytes(32)
    .toString('base64url');

}

function hashToken(token) {

  return crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');

}

/* ========================================================
   ADMIN
   ======================================================== */

function requireAdmin(
  req,
  res,
  next
) {

  const supplied =
    req.get('x-admin-token') ||
    req.body?.adminToken ||
    req.query?.adminToken ||
    '';

  if (!ADMIN_TOKEN) {

    return res.status(503).json({

      error:
        'ADMIN_TOKEN não configurado no servidor.'

    });

  }

  if (
    supplied !== ADMIN_TOKEN
  ) {

    return res.status(401).json({

      error:
        'Acesso não autorizado.'

    });

  }

  next();

}

/* ========================================================
   PEDIDOS
   ======================================================== */

async function getOrder(
  orderId
) {

  const r =
    await db(
      `
        SELECT *
        FROM orders

       /* ========================================================
   ANEXOS DOS QR CODES
   ======================================================== */

function ticketAttachments(tickets) {

  return tickets.map(t => {

    const ticketId =
      t.ticket_id ||
      t.ticketId ||
      '';

    const qrBase64 =
      t.qr_base64 ||
      t.qrBase64 ||
      '';

    if (!ticketId || !qrBase64) {

      throw new Error(
        `QR Code ausente para o ingresso ${
          ticketId || '(sem código)'
        }.`
      );

    }

    return {

      content:
        qrBase64,

      filename:
        `qr-${ticketId}.png`,

      contentId:
        `qr-${ticketId}`,

      contentType:
        'image/png'

    };

  });

}

/* ========================================================
   GERAR INGRESSOS + ENVIAR PELA GMAIL API
   ======================================================== */

async function fulfillOrder(orderId) {

  const order =
    await getOrder(orderId);

  if (
    !order ||
    order.status !== 'approved'
  ) {

    return order;

  }

  const expected =
    totalTicketCount(order);

  let current =
    await countTickets(orderId);

  if (current < expected) {

    const flat = [];

    for (
      const item
      of order.items
    ) {

      for (
        let i = 0;
        i < item.quantity;
        i++
      ) {

        flat.push(item);

      }

    }

    for (
      let i = current;
      i < expected;
      i++
    ) {

      const t =
        await buildTicket(
          order,
          flat[i]
        );

      try {

        await db(
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
            VALUES(
              $1,$2,$3,$4,$5,
              $6,$7,$8,$9
            )
          `,
          [

            t.ticketId,

            orderId,

            t.tokenHash,

            t.batchId,

            t.batchName,

            t.unitPrice,

            t.buyerName,

            t.buyerEmail,

            t.qrBase64

          ]
        );

      } catch (e) {

        if (e.code !== '23505') {

          throw e;

        }

        i--;

        continue;

      }

    }

    current =
      await countTickets(
        orderId
      );

  }

  /* ======================================================
     ENVIO DO INGRESSO PELA GMAIL API
     ====================================================== */

  if (
    current === expected &&
    !order.emailSentAt
  ) {

    if (!gmailReady()) {

      await db(
        `
          UPDATE orders
          SET
            email_error=$1,
            updated_at=NOW()
          WHERE order_id=$2
        `,
        [

          'Gmail API não está configurada corretamente.',

          orderId

        ]
      );

    } else {

      try {

        const tickets =
          await getTickets(
            orderId
          );

        await sendGmail({

          to:
            order.buyer.email,

          subject:
            `Seu ingresso — ${EVENT_NAME}`,

          text:
            `Pagamento aprovado. Seus ${
              tickets.length
            } ingresso(s) para ${
              EVENT_NAME
            } estão neste e-mail.`,

          attachments:
            ticketAttachments(
              tickets
            ),

          html:
            `
              <div style="
                background:#070707;
                padding:28px 12px;
                font-family:Arial,sans-serif
              ">

                <div style="
                  max-width:620px;
                  margin:auto;
                  color:#fff;
                  text-align:center
                ">

                  <div style="
                    font-size:12px;
                    letter-spacing:3px;
                    color:#ff3a4a;
                    font-weight:800
                  ">
                    PAGAMENTO APROVADO
                  </div>

                  <h1>
                    ${esc(EVENT_NAME)}
                  </h1>

                  <p style="
                    color:#bbb
                  ">
                    Olá,
                    ${esc(order.buyer.name)}.
                    Guarde este e-mail e apresente
                    o QR Code correspondente na entrada.
                  </p>

                  ${
                    tickets
                      .map(ticketHtml)
                      .join('')
                  }

                  <p style="
                    color:#777;
                    font-size:11px
                  ">
                    Pedido:
                    ${esc(order.orderId)}
                  </p>

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

        console.error(
          'ERRO GMAIL API:',
          emailError
        );

        const errorText =
          [
            emailError.message,

            emailError.code
              ? `code=${emailError.code}`
              : null

          ]
          .filter(Boolean)
          .join(' | ');

        await db(
          `
            UPDATE orders
            SET
              email_error=$1,
              updated_at=NOW()
            WHERE order_id=$2
          `,
          [

            errorText.substring(
              0,
              2000
            ),

            orderId

          ]
        );

      }

    }

  }

  return await getOrder(
    orderId
  );

}

/* ========================================================
   LOCK PARA EVITAR DUPLICAÇÃO
   ======================================================== */

const locks =
  new Map();

function fulfillLocked(id) {

  if (locks.has(id)) {

    return locks.get(id);

  }

  const p =
    fulfillOrder(id)
      .catch(e => {

        console.error(
          'Emissão:',
          e
        );

        throw e;

      })
      .finally(() =>
        locks.delete(id)
      );

  locks.set(
    id,
    p
  );

  return p;

}

/* ========================================================
   HEALTH CHECK
   ======================================================== */

app.get(
  '/health',
  async (req, res) => {

    try {

      if (pool) {

        await db(
          'SELECT 1'
        );

      }

      res.json({

        ok: true,

        db:
          Boolean(pool),

        event:
          EVENT_NAME,

        emailProvider:
          'Gmail API',

        gmailConfigured:
          gmailReady()

      });

    } catch (e) {

      res.status(503).json({

        ok: false,

        error:
          e.message

      });

    }

  }
);

/* ========================================================
   CONFIGURAÇÃO PÚBLICA DO MERCADO PAGO
   ======================================================== */

app.get(
  '/api/public-config',
  (req, res) => {

    res.json({

      mercadoPagoPublicKey:
        PUBLIC_KEY

    });

  }
);

/* ========================================================
   MERCADO PAGO
   ======================================================== */

async function mpRequest(
  url,
  options = {}
) {

  if (!ACCESS_TOKEN) {

    throw new Error(
      'MP_ACCESS_TOKEN não configurado no servidor.'
    );

  }

  const r =
    await fetch(
      url,
      {

        ...options,

        headers: {

          Authorization:
            `Bearer ${ACCESS_TOKEN}`,

          'Content-Type':
            'application/json',

          ...(options.headers || {})

        }

      }
    );

  const text =
    await r.text();

  let data;

  try {

    data =
      JSON.parse(text);

  } catch {

    data = {
      message: text
    };

  }

  if (!r.ok) {

    console.error(
      'Mercado Pago:',
      r.status,
      data
    );

    throw new Error(
      data.message ||
      'Erro no Mercado Pago.'
    );

  }

  return data;

    }
    /* ========================================================
   CRIAR PIX
   ======================================================== */

app.post(
  '/api/create-pix',
  async (req, res) => {

    try {

      const {
        buyer,
        items
      } = req.body || {};

      const name =
        String(
          buyer?.name || ''
        ).trim();

      const email =
        String(
          buyer?.email || ''
        ).trim();

      const phone =
        String(
          buyer?.phone || ''
        )
        .replace(/\D/g, '');

      const cpf =
        cleanCPF(
          buyer?.cpf
        );

      if (
        !name ||
        !email ||
        cpf.length !== 11
      ) {

        return res.status(400).json({

          error:
            'Informe nome, e-mail e CPF válidos.'

        });

      }

      if (phone.length !== 11) {

        return res.status(400).json({

          error:
            'Informe um telefone válido.'

        });

      }

      const {
        normalized,
        total
      } =
        calculateItems(items);

      const orderId =
        crypto.randomUUID();

      const {
        first_name,
        last_name
      } =
        splitName(name);

      const body = {

        transaction_amount:
          Number(
            total.toFixed(2)
          ),

        description:
          `${EVENT_NAME} - ${
            normalized
              .map(
                i =>
                  `${i.quantity}x ${i.name}`
              )
              .join(', ')
          }`,

        payment_method_id:
          'pix',

        external_reference:
          orderId,

        payer: {

          email,

          first_name,

          last_name,

          identification: {

            type:
              'CPF',

            number:
              cpf

          }

        }

      };

      if (PUBLIC_BASE_URL) {

        body.notification_url =
          `${PUBLIC_BASE_URL}/api/mercadopago/webhook`;

      }

      const payment =
        await mpRequest(
          'https://api.mercadopago.com/v1/payments',
          {

            method:
              'POST',

            headers: {

              'X-Idempotency-Key':
                crypto.randomUUID()

            },

            body:
              JSON.stringify(body)

          }
        );

      const tx =
        payment
          .point_of_interaction
          ?.transaction_data;

      if (
        !tx?.qr_code ||
        !tx?.qr_code_base64
      ) {

        throw new Error(
          'Mercado Pago não retornou o QR Code PIX.'
        );

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
          VALUES(
            $1,$2,$3,$4,$5,$6,$7,$8,$9
          )
        `,
        [

          orderId,

          String(
            payment.id
          ),

          payment.status ||
            'pending',

          total,

          name,

          email,

          cpf,

          phone,

          JSON.stringify(
            normalized
          )

        ]
      );

      res.json({

        orderId,

        paymentId:
          String(payment.id),

        status:
          payment.status,

        qrCode:
          tx.qr_code,

        qrCodeBase64:
          tx.qr_code_base64

      });

    } catch (e) {

      console.error(e);

      res.status(400).json({

        error:
          e.message ||
          'Não foi possível gerar o PIX.'

      });

    }

  }
);

/* ========================================================
   CRIAR PAGAMENTO COM CARTÃO
   ======================================================== */

app.post(
  '/api/create-card-payment',
  async (req, res) => {

    try {

      const {
        buyer,
        items,
        token,
        paymentMethodId,
        issuerId,
        installments
      } =
        req.body || {};

      const name =
        String(
          buyer?.name || ''
        ).trim();

      const email =
        String(
          buyer?.email || ''
        ).trim();

      const phone =
        String(
          buyer?.phone || ''
        )
        .replace(/\D/g, '');

      const cpf =
        cleanCPF(
          buyer?.cpf
        );

      const cardToken =
        String(
          token || ''
        ).trim();

      const methodId =
        String(
          paymentMethodId || ''
        ).trim();

      const parsedIssuerId =
        issuerId
          ? String(issuerId)
          : undefined;

      const parsedInstallments =
        Number(
          installments || 1
        );

      if (
        !name ||
        !email ||
        cpf.length !== 11
      ) {

        return res.status(400).json({

          error:
            'Informe nome, e-mail e CPF válidos.'

        });

      }

      if (phone.length !== 11) {

        return res.status(400).json({

          error:
            'Informe um telefone válido.'

        });

      }

      if (
        !cardToken ||
        !methodId
      ) {

        return res.status(400).json({

          error:
            'Não foi possível tokenizar o cartão. Verifique os dados.'

        });

      }

      if (
        !Number.isInteger(
          parsedInstallments
        ) ||
        parsedInstallments < 1 ||
        parsedInstallments > 24
      ) {

        return res.status(400).json({

          error:
            'Quantidade de parcelas inválida.'

        });

      }

      const {
        normalized,
        total
      } =
        calculateItems(items);

      const orderId =
        crypto.randomUUID();

      const {
        first_name,
        last_name
      } =
        splitName(name);

      const body = {

        transaction_amount:
          Number(
            total.toFixed(2)
          ),

        description:
          `${EVENT_NAME} - ${
            normalized
              .map(
                i =>
                  `${i.quantity}x ${i.name}`
              )
              .join(', ')
          }`,

        payment_method_id:
          methodId,

        token:
          cardToken,

        installments:
          parsedInstallments,

        external_reference:
          orderId,

        payer: {

          email,

          first_name,

          last_name,

          identification: {

            type:
              'CPF',

            number:
              cpf

          }

        }

      };

      if (parsedIssuerId) {

        body.issuer_id =
          parsedIssuerId;

      }

      if (PUBLIC_BASE_URL) {

        body.notification_url =
          `${PUBLIC_BASE_URL}/api/mercadopago/webhook`;

      }

      const payment =
        await mpRequest(
          'https://api.mercadopago.com/v1/payments',
          {

            method:
              'POST',

            headers: {

              'X-Idempotency-Key':
                crypto.randomUUID()

            },

            body:
              JSON.stringify(body)

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
          VALUES(
            $1,$2,$3,$4,$5,$6,$7,$8,$9
          )
        `,
        [

          orderId,

          String(
            payment.id
          ),

          payment.status ||
            'pending',

          total,

          name,

          email,

          cpf,

          phone,

          JSON.stringify(
            normalized
          )

        ]
      );

      if (
        payment.status ===
        'approved'
      ) {

        await fulfillLocked(
          orderId
        );

      }

      const finalOrder =
        await getOrder(
          orderId
        );

      res.json({

        orderId,

        paymentId:
          String(payment.id),

        status:
          finalOrder?.status ||
          payment.status,

        statusDetail:
          payment.status_detail ||
          null

      });

    } catch (e) {

      console.error(
        'Erro pagamento cartão:',
        e
      );

      res.status(400).json({

        error:
          e.message ||
          'Não foi possível processar o pagamento com cartão.'

      });

    }

  }
);

/* ========================================================
   STATUS DO PAGAMENTO
   ======================================================== */

app.get(
  '/api/payment-status/:orderId',
  async (req, res) => {

    try {

      const order =
        await getOrder(
          req.params.orderId
        );

      if (!order) {

        return res.status(404).json({

          error:
            'Compra não encontrada.'

        });

      }

      const payment =
        await mpRequest(
          `https://api.mercadopago.com/v1/payments/${encodeURIComponent(
            order.paymentId
          )}`
        );

      await db(
        `
          UPDATE orders
          SET
            status=$1,
            updated_at=NOW()
          WHERE order_id=$2
        `,
        [

          payment.status ||
            order.status,

          order.orderId

        ]
      );

      const finalOrder =
        payment.status === 'approved'

          ? await fulfillLocked(
              order.orderId
            )

          : await getOrder(
              order.orderId
            );

      const ticketCount =
        await countTickets(
          order.orderId
        );

      res.json({

        status:
          finalOrder.status,

        paymentId:
          finalOrder.paymentId,

        ticketsReady:
          ticketCount ===
          totalTicketCount(
            finalOrder
          ),

        emailSent:
          Boolean(
            finalOrder.emailSentAt
          ),

        emailError:
          finalOrder.emailError ||
          null

      });

    } catch (e) {

      res.status(500).json({

        error:
          e.message ||
          'Não foi possível consultar o pagamento.'

      });

    }

  }
);

/* ========================================================
   WEBHOOK MERCADO PAGO
   ======================================================== */

app.post(
  '/api/mercadopago/webhook',
  async (req, res) => {

    res.sendStatus(200);

    try {

      const paymentId =
        req.body?.data?.id ||
        req.query?.id ||
        req.body?.id;

      if (!paymentId)
        return;

      const payment =
        await mpRequest(
          `https://api.mercadopago.com/v1/payments/${encodeURIComponent(
            paymentId
          )}`
        );

      const orderId =
        payment.external_reference;

      if (orderId) {

        await db(
          `
            UPDATE orders
            SET
              status=$1,
              updated_at=NOW()
            WHERE order_id=$2
          `,
          [

            payment.status,

            orderId

          ]
        );

        if (
          payment.status ===
          'approved'
        ) {

          await fulfillLocked(
            orderId
          );

        }

      }

    } catch (e) {

      console.error(
        'Webhook Mercado Pago:',
        e
      );

    }

  }
);

/* ========================================================
   QR CODE DO INGRESSO
   ======================================================== */

app.get(
  '/api/tickets/qr/:ticketId.png',
  async (req, res) => {

    try {

      const ticketId =
        String(
          req.params.ticketId || ''
        ).trim();

      if (
        !/^BMD2-[A-F0-9]{10}$/i.test(
          ticketId
        )
      ) {

        return res
          .status(400)
          .send(
            'QR inválido.'
          );

      }

      const r =
        await db(
          `
            SELECT qr_base64
            FROM tickets
            WHERE UPPER(ticket_id)
              = UPPER($1)
            LIMIT 1
          `,
          [ticketId]
        );

      const base64 =
        r.rows[0]?.qr_base64;

      if (!base64) {

        return res
          .status(404)
          .send(
            'QR não encontrado.'
          );

      }

      const buffer =
        Buffer.from(
          base64,
          'base64'
        );

      res.set({

        'Content-Type':
          'image/png',

        'Content-Length':
          String(
            buffer.length
          ),

        'Cache-Control':
          'public, max-age=31536000, immutable',

        'X-Content-Type-Options':
          'nosniff'

      });

      return res.end(
        buffer
      );

    } catch (e) {

      console.error(
        'Erro ao entregar QR:',
        e
      );

      return res
        .status(500)
        .send(
          'Não foi possível carregar o QR.'
        );

    }

  }
);
/* ========================================================
   VALIDAÇÃO PÚBLICA DO INGRESSO
   ======================================================== */

async function consumeTicketToken(rawToken) {

  const token =
    String(rawToken || '').trim();

  if (!token) {

    return {

      status: 400,

      body: {
        valid: false,
        error: 'QR Code inválido.'
      }

    };

  }

  const h =
    hashToken(token);

  const r =
    await db(
      `
        SELECT
          t.*,
          o.status AS order_status
        FROM tickets t
        JOIN orders o
          ON o.order_id=t.order_id
        WHERE t.token_hash=$1
      `,
      [h]
    );

  const t =
    r.rows[0];

  if (!t) {

    return {

      status: 404,

      body: {
        valid: false,
        error: 'Ingresso não encontrado.'
      }

    };

  }

  if (
    t.order_status !==
    'approved'
  ) {

    return {

      status: 400,

      body: {
        valid: false,
        error: 'Pagamento não aprovado.'
      }

    };

  }

  const used =
    await db(
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

    const fresh =
      await db(
        `
          SELECT
            ticket_id,
            batch_name,
            buyer_name,
            used_at
          FROM tickets
          WHERE ticket_id=$1
        `,
        [t.ticket_id]
      );

    const already =
      fresh.rows[0];

    return {

      status: 409,

      body: {

        valid: false,

        used: true,

        error:
          'Este ingresso já foi utilizado.',

        ticket:
          already
            ? {

                ticketId:
                  already.ticket_id,

                batchName:
                  already.batch_name,

                buyerName:
                  already.buyer_name,

                usedAt:
                  already.used_at

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

      message:
        'Entrada liberada.',

      ticket: {

        ticketId:
          t.ticket_id,

        batchName:
          t.batch_name,

        buyerName:
          t.buyer_name,

        usedAt:
          used.rows[0].used_at

      }

    }

  };

}

/* ========================================================
   ESCANEAR QR PUBLICAMENTE
   ======================================================== */

app.get(
  '/api/tickets/scan',
  async (req, res) => {

    try {

      const result =
        await consumeTicketToken(
          req.query.ticket
        );

      return res
        .status(result.status)
        .json(result.body);

    } catch (e) {

      console.error(
        'Erro na validação pública:',
        e
      );

      return res.status(500).json({

        valid: false,

        error:
          'Não foi possível validar o ingresso.'

      });

    }

  }
);

/* ========================================================
   VALIDAR INGRESSO PELO ADMIN
   ======================================================== */

app.post(
  '/api/tickets/validate',
  requireAdmin,
  async (req, res) => {

    try {

      const result =
        await consumeTicketToken(
          req.body?.token
        );

      return res
        .status(result.status)
        .json(result.body);

    } catch (e) {

      console.error(
        'Erro ao validar ingresso:',
        e
      );

      return res.status(500).json({

        valid: false,

        error:
          e.message ||
          'Não foi possível validar o ingresso.'

      });

    }

  }
);

/* ========================================================
   REENVIAR INGRESSO
   ======================================================== */

app.post(
  '/api/tickets/resend/:orderId',
  requireAdmin,
  async (req, res) => {

    try {

      const order =
        await getOrder(
          req.params.orderId
        );

      if (!order) {

        return res.status(404).json({

          error:
            'Compra não encontrada.'

        });

      }

      if (
        order.status !==
        'approved'
      ) {

        return res.status(400).json({

          error:
            'Pagamento ainda não aprovado.'

        });

      }

      const tickets =
        await getTickets(
          order.orderId
        );

      if (
        tickets.length !==
        totalTicketCount(order)
      ) {

        await fulfillLocked(
          order.orderId
        );

      }

      const fresh =
        await getOrder(
          order.orderId
        );

      const ts =
        await getTickets(
          order.orderId
        );

      if (!gmailReady()) {

        throw new Error(
          'Gmail API não configurada.'
        );

      }

      await sendGmail({

        to:
          fresh.buyer.email,

        subject:
          `Reenvio — ${EVENT_NAME}`,

        text:
          `Seus ingressos para ${EVENT_NAME}.`,

        attachments:
          ticketAttachments(ts),

        html:
          `
            <div style="
              background:#070707;
              padding:28px 12px;
              font-family:Arial,sans-serif
            ">

              ${ts
                .map(ticketHtml)
                .join('')
              }

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

        message:
          'Ingressos reenviados.'

      });

    } catch (e) {

      res.status(500).json({

        error:
          e.message ||
          'Não foi possível reenviar os ingressos.'

      });

    }

  }
);

/* ========================================================
   ESTATÍSTICAS
   ======================================================== */

app.get(
  '/api/tickets/stats',
  requireAdmin,
  async (req, res) => {

    try {

      const a =
        await db(
          `
            SELECT
              COUNT(*)::int AS n
            FROM orders
            WHERE status='approved'
          `
        );

      const s =
        await db(
          `
            SELECT

              COUNT(*)::int AS n,

              COUNT(*)
                FILTER(
                  WHERE used_at IS NOT NULL
                )::int AS used

            FROM tickets
          `
        );

      const sold =
        s.rows[0].n;

      const used =
        s.rows[0].used;

      res.json({

        approvedOrders:
          a.rows[0].n,

        soldTickets:
          sold,

        usedTickets:
          used,

        availableTickets:
          Math.max(
            0,
            sold - used
          )

      });

    } catch (e) {

      res.status(500).json({

        error:
          e.message

      });

    }

  }
);

/* ========================================================
   COMPRA DE TESTE
   ======================================================== */

app.post(
  '/api/admin/test-order',
  requireAdmin,
  async (req, res) => {

    try {

      const body =
        req.body || {};

      const name =
        String(
          body.name ||
          'Cliente de Teste'
        ).trim();

      const email =
        String(
          body.email ||
          ''
        ).trim();

      const phone =
        String(
          body.phone ||
          '61999999999'
        )
        .replace(/\D/g, '');

      const cpf =
        cleanCPF(
          body.cpf ||
          '11144477735'
        );

      const batchId =
        String(
          body.batchId ||
          'pre'
        );

      if (!email) {

        return res.status(400).json({

          error:
            'Informe o e-mail que receberá o ingresso de teste.'

        });

      }

      if (!batches[batchId]) {

        return res.status(400).json({

          error:
            'Tipo de ingresso de teste inválido.'

        });

      }

      if (cpf.length !== 11) {

        return res.status(400).json({

          error:
            'CPF de teste inválido.'

        });

      }

      const orderId =
        `TEST-${crypto.randomUUID()}`;

      const paymentId =
        `TEST-PAY-${crypto.randomUUID()}`;

      const item = {

        id:
          batchId,

        name:
          batches[batchId].name,

        quantity:
          1,

        unit_price:
          batches[batchId].price

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
          VALUES(
            $1,$2,'approved',
            $3,$4,$5,$6,$7,$8
          )
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

      const fulfilled =
        await fulfillLocked(
          orderId
        );

      const tickets =
        await getTickets(
          orderId
        );

      res.json({

        ok: true,

        test: true,

        orderId,

        status:
          fulfilled.status,

        emailSent:
          Boolean(
            fulfilled.emailSentAt
          ),

        emailError:
          fulfilled.emailError ||
          null,

        tickets:
          tickets.map(t => ({

            ticketId:
              t.ticket_id,

            batchName:
              t.batch_name,

            usedAt:
              t.used_at

          }))

      });

    } catch (e) {

      console.error(
        'Compra de teste:',
        e
      );

      res.status(500).json({

        error:
          e.message ||
          'Não foi possível criar a compra de teste.'

      });

    }

  }
);

/* ========================================================
   TESTE ESPECÍFICO DE CARTÃO
   ======================================================== */

app.post(
  '/api/admin/test-card-payment',
  requireAdmin,
  async (req, res) => {

    try {

      const body =
        req.body || {};

      const name =
        String(
          body.name ||
          'Cliente Teste Cartão'
        ).trim();

      const email =
        String(
          body.email ||
          ''
        ).trim();

      const phone =
        String(
          body.phone ||
          '61999999999'
        )
        .replace(/\D/g, '');

      const cpf =
        cleanCPF(
          body.cpf ||
          '11144477735'
        );

      const batchId =
        String(
          body.batchId ||
          'pre'
        );

      if (!email) {

        return res.status(400).json({

          error:
            'Informe o e-mail que receberá o teste.'

        });

      }

      if (!batches[batchId]) {

        return res.status(400).json({

          error:
            'Tipo de ingresso inválido.'

        });

      }

      const orderId =
        `TEST-CARD-${crypto.randomUUID()}`;

      const paymentId =
        `TEST-CARD-PAY-${crypto.randomUUID()}`;

      const item = {

        id:
          batchId,

        name:
          batches[batchId].name,

        quantity:
          1,

        unit_price:
          batches[batchId].price

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
          VALUES(
            $1,$2,'approved',
            $3,$4,$5,$6,$7,$8
          )
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

      const fulfilled =
        await fulfillLocked(
          orderId
        );

      const tickets =
        await getTickets(
          orderId
        );

      res.json({

        ok: true,

        test: true,

        simulatedPayment:
          'card',

        paymentStatus:
          'approved',

        orderId,

        emailSent:
          Boolean(
            fulfilled.emailSentAt
          ),

        emailError:
          fulfilled.emailError ||
          null,

        tickets:
          tickets.map(t => ({

            ticketId:
              t.ticket_id,

            batchName:
              t.batch_name,

            usedAt:
              t.used_at

          }))

      });

    } catch (e) {

      console.error(
        'Teste cartão:',
        e
      );

      res.status(500).json({

        error:
          e.message ||
          'Não foi possível executar o teste de cartão.'

      });

    }

  }
);

/* ========================================================
   APAGAR COMPRAS DE TESTE
   ======================================================== */

app.delete(
  '/api/admin/test-orders',
  requireAdmin,
  async (req, res) => {

    try {

      const result =
        await db(
          `
            DELETE FROM orders
            WHERE order_id LIKE 'TEST-%'
            RETURNING order_id
          `
        );

      res.json({

        ok: true,

        deleted:
          result.rowCount

      });

    } catch (e) {

      console.error(
        'Excluir testes:',
        e
      );

      res.status(500).json({

        error:
          e.message ||
          'Não foi possível excluir as compras de teste.'

      });

    }

  }
);

/* ========================================================
   ROTA FINAL
   ======================================================== */

app.get(
  '/{*splat}',
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'index.html'
      )
    );

  }
);

/* ========================================================
   INICIAR SERVIDOR
   ======================================================== */

initDb()
  .then(() => {

    app.listen(
      PORT,
      '0.0.0.0',
      () => {

        console.log(
          `${EVENT_NAME} em http://0.0.0.0:${PORT}`
        );

        console.log(
          'E-mail: Gmail API'
        );

        console.log(
          `GMAIL_USER: ${GMAIL_USER}`
        );

        console.log(
          `Gmail configurado: ${gmailReady()}`
        );

      }
    );

  })
  .catch(e => {

    console.error(
      'Falha ao inicializar banco:',
      e
    );

    process.exit(1);

  });
