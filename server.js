require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Resend } = require('resend');
const { Pool } = require('pg');

const app = express();

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

const PUBLIC_BASE_URL =
  (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const ADMIN_TOKEN =
  process.env.ADMIN_TOKEN || '';

const RESEND_API_KEY =
  process.env.RESEND_API_KEY || '';

const EMAIL_FROM =
  process.env.EMAIL_FROM || '';

const EVENT_NAME =
  'Baile da Madrid 2.0';


/* ========================================================
   RESEND
   ======================================================== */

const resend =
  RESEND_API_KEY
    ? new Resend(RESEND_API_KEY)
    : null;


/* ========================================================
   LOTES
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
   BANCO
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


/* ========================================================
   INICIALIZAR BANCO
   ======================================================== */

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
        TIMESTAMPTZ
        NOT NULL
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
        TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      used_at
        TIMESTAMPTZ

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

}


/* ========================================================
   UTILIDADES
   ======================================================== */

function cleanCPF(value) {

  return String(
    value || ''
  ).replace(
    /\D/g,
    ''
  );

}


function splitName(name) {

  const parts =
    String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);


  return {

    first_name:
      parts.shift() ||
      'Cliente',

    last_name:
      parts.join(' ') ||
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


  for (const item of items) {

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


  const totalTickets =
    normalized.reduce(
      (sum, item) =>
        sum + item.quantity,
      0
    );


  if (totalTickets > 10) {

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
        sum + Number(
          item.quantity || 0
        ),
      0
    );

}


function makeTicketCode() {

  return (
    `BMD2-${crypto
      .randomBytes(5)
      .toString('hex')
      .toUpperCase()}`
  );

}


function makeTicketToken() {

  return crypto.randomBytes(
    32
  ).toString('base64url');

}


function hashToken(token) {

  return crypto
    .createHash('sha256')
    .update(
      String(token),
      'utf8'
    )
    .digest('hex');

}


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
   RESEND STATUS
   ======================================================== */

app.get(
  '/api/admin/test-email',
  requireAdmin,
  async (req, res) => {

    try {

      if (!resend) {

        return res.status(500).json({

          ok: false,

          error:
            'RESEND_API_KEY não configurada.'

        });

      }


      if (!EMAIL_FROM) {

        return res.status(500).json({

          ok: false,

          error:
            'EMAIL_FROM não configurado.'

        });

      }


      const { data, error } =
        await resend.emails.send({

          from:
            EMAIL_FROM,

          to: [
            req.query.email ||
            EMAIL_FROM
          ],

          subject:
            `Teste — ${EVENT_NAME}`,

          html:
            '<h2>Resend funcionando!</h2><p>O envio de e-mail está funcionando corretamente.</p>'

        });


      if (error) {

        console.error(
          'Resend:',
          error
        );


        return res.status(500).json({

          ok: false,

          error:
            error.message ||
            'Erro no Resend.'

        });

      }


      res.json({

        ok: true,

        message:
          'E-mail enviado pelo Resend.',

        id:
          data?.id || null

      });

    }

    catch (e) {

      console.error(
        'Teste Resend:',
        e
      );


      res.status(500).json({

        ok: false,

        error:
          e.message ||
          'Falha no Resend.'

      });

    }

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


  const response =
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
    await response.text();


  let data;


  try {

    data =
      JSON.parse(text);

  }

  catch {

    data = {
      message: text
    };

  }


  if (!response.ok) {

    console.error(
      'Mercado Pago:',
      response.status,
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
   URL DO INGRESSO
   ======================================================== */

function ticketUrl(token) {

  if (!PUBLIC_BASE_URL) {

    throw new Error(
      'PUBLIC_BASE_URL não configurado.'
    );

  }


  return (
    `${PUBLIC_BASE_URL}/validar.html?ticket=${encodeURIComponent(token)}`
  );

}


/* ========================================================
   CRIAR INGRESSO
   ======================================================== */

async function buildTicket(
  order,
  item
) {

  const token =
    makeTicketToken();


  const ticketId =
    makeTicketCode();


  const url =
    ticketUrl(token);


  console.log(
    'Criando ingresso:',
    ticketId,
    'tokenLength=',
    token.length
  );


  const qrDataUrl =
    await QRCode.toDataURL(
      url,
      {

        errorCorrectionLevel:
          'H',

        margin:
          2,

        width:
          360

      }
    );


  return {

    ticketId,

    token,

    tokenHash:
      hashToken(token),

    batchId:
      item.id,

    batchName:
      item.name,

    unitPrice:
      item.unit_price,

    buyerName:
      order.buyer.name,

    buyerEmail:
      order.buyer.email,

    qrBase64:
      qrDataUrl.split(',')[1]

  };

}


/* ========================================================
   ESCAPAR HTML
   ======================================================== */

function esc(value) {

  return String(
    value ?? ''
  ).replace(
    /[&<>"']/g,
    char => ({

      '&':
        '&amp;',

      '<':
        '&lt;',

      '>':
        '&gt;',

      '"':
        '&quot;',

      "'":
        '&#39;'

    }[char])
  );

}


/* ========================================================
   HTML DO INGRESSO
   ======================================================== */

function ticketHtml(ticket) {

  return `

    <div style="
      max-width:520px;
      margin:0 auto 24px;
      background:#111;
      border:1px solid #2b2b2b;
      border-radius:18px;
      padding:24px;
      text-align:center;
      color:#fff;
      font-family:Arial,sans-serif
    ">

      <div style="
        font-size:12px;
        letter-spacing:3px;
        color:#ff3a4a;
        font-weight:800
      ">
        INGRESSO DIGITAL
      </div>


      <h2 style="
        margin:8px 0 4px;
        font-size:27px
      ">
        ${esc(EVENT_NAME)}
      </h2>


      <div style="
        font-size:16px;
        font-weight:700;
        margin-bottom:18px
      ">
        ${esc(ticket.batchName)}
      </div>


      <img
        src="cid:qr-${ticket.ticketId}"
        alt="QR Code do ingresso"
        width="250"
        height="250"
        style="
          display:block;
          margin:0 auto 18px;
          background:#fff;
          padding:10px;
          border-radius:10px
        "
      >


      <div style="
        font-size:13px;
        color:#aaa
      ">
        Titular
      </div>


      <div style="
        font-size:18px;
        font-weight:800;
        margin:3px 0 14px
      ">
        ${esc(ticket.buyerName)}
      </div>


      <div style="
        font-size:12px;
        color:#aaa
      ">
        Código do ingresso
      </div>


      <div style="
        font-family:monospace;
        font-size:16px;
        font-weight:800;
        letter-spacing:1px;
        margin-top:4px
      ">
        ${esc(ticket.ticketId)}
      </div>


      <p style="
        font-size:12px;
        color:#999;
        margin:18px 0 0
      ">
        Apresente este QR Code na entrada.
        Cada ingresso possui um código único.
      </p>

    </div>

  `;

}


/* ========================================================
   PEDIDOS
   ======================================================== */

async function getOrder(
  orderId
) {

  const result =
    await db(
      `
        SELECT *
        FROM orders
        WHERE order_id=$1
      `,
      [orderId]
    );


  if (!result.rows[0]) {

    return null;

  }


  const row =
    result.rows[0];


  return {

    orderId:
      row.order_id,

    paymentId:
      row.payment_id,

    status:
      row.status,

    total:
      Number(row.total),

    items:
      row.items,

    buyer: {

      name:
        row.buyer_name,

      email:
        row.buyer_email,

      cpf:
        row.buyer_cpf,

      phone:
        row.buyer_phone

    },

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,

    emailSentAt:
      row.email_sent_at,

    emailError:
      row.email_error

  };

}


async function countTickets(
  orderId
) {

  const result =
    await db(
      `
        SELECT COUNT(*)::int AS n
        FROM tickets
        WHERE order_id=$1
      `,
      [orderId]
    );


  return result.rows[0].n;

}


async function getTickets(
  orderId
) {

  const result =
    await db(
      `
        SELECT
          ticket_id,
          batch_id,
          batch_name,
          unit_price,
          buyer_name,
          buyer_email,
          qr_base64,
          created_at,
          used_at
        FROM tickets
        WHERE order_id=$1
        ORDER BY created_at
      `,
      [orderId]
    );


  return result.rows;

}


/* ========================================================
   ENVIAR EMAIL PELO RESEND
   ======================================================== */

async function sendTicketEmail(
  order,
  tickets,
  isResend = false
) {

  if (!resend) {

    throw new Error(
      'RESEND_API_KEY não configurada.'
    );

  }


  if (!EMAIL_FROM) {

    throw new Error(
      'EMAIL_FROM não configurado.'
    );

  }


  const attachments =
    tickets.map(ticket => ({

      filename:
        `${ticket.ticket_id}.png`,

      content:
        ticket.qr_base64,

      contentId:
        `qr-${ticket.ticket_id}`

    }));


  const subject =
    isResend
      ? `Reenvio — ${EVENT_NAME}`
      : `Seu ingresso — ${EVENT_NAME}`;


  const { data, error } =
    await resend.emails.send({

      from:
        EMAIL_FROM,

      to: [
        order.buyer.email
      ],

      subject,

      text:
        `Pagamento aprovado. Seus ${tickets.length} ingresso(s) para ${EVENT_NAME} estão neste e-mail.`,

      html: `

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


            <p style="color:#bbb">
              Olá,
              ${esc(order.buyer.name)}.
              Guarde este e-mail e apresente
              o QR Code correspondente na entrada.
            </p>


            ${tickets
              .map(ticketHtml)
              .join('')}


            <p style="
              color:#777;
              font-size:11px
            ">
              Pedido:
              ${esc(order.orderId)}
            </p>

          </div>

        </div>

      `,

      attachments

    });


  if (error) {

    console.error(
      'Erro Resend:',
      error
    );


    throw new Error(
      error.message ||
      'Resend não conseguiu enviar o e-mail.'
    );

  }


  return data;

}


/* ========================================================
   GERAR INGRESSOS
   ======================================================== */

async function fulfillOrder(
  orderId
) {

  const order =
    await getOrder(
      orderId
    );


  if (
    !order ||
    order.status !== 'approved'
  ) {

    return order;

  }


  const expected =
    totalTicketCount(order);


  let current =
    await countTickets(
      orderId
    );


  /*
   * GERA OS INGRESSOS
   */

  if (current < expected) {

    const flat = [];


    for (
      const item of order.items
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

      const ticket =
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
              $1,$2,$3,$4,$5,$6,$7,$8,$9
            )
          `,
          [

            ticket.ticketId,

            orderId,

            ticket.tokenHash,

            ticket.batchId,

            ticket.batchName,

            ticket.unitPrice,

            ticket.buyerName,

            ticket.buyerEmail,

            ticket.qrBase64

          ]
        );


        /*
         * DIAGNÓSTICO:
         * verificamos imediatamente
         * se o token que acabamos
         * de salvar corresponde
         * ao hash salvo.
         */

        const check =
          await db(
            `
              SELECT ticket_id
              FROM tickets
              WHERE token_hash=$1
            `,
            [
              ticket.tokenHash
            ]
          );


        if (
          !check.rows.length
        ) {

          throw new Error(
            'Falha interna: token criado mas não encontrado imediatamente após gravação.'
          );

        }


      }

      catch (e) {

        if (
          e.code === '23505'
        ) {

          i--;

          continue;

        }


        throw e;

      }

    }


    current =
      await countTickets(
        orderId
      );

  }


  /*
   * ENVIO DO EMAIL
   */

  if (
    current === expected &&
    !order.emailSentAt
  ) {

    try {

      const tickets =
        await getTickets(
          orderId
        );


      await sendTicketEmail(
        order,
        tickets,
        false
      );


      await db(
        `
          UPDATE orders
          SET
            email_sent_at=NOW(),
            email_error=NULL,
            updated_at=NOW()
          WHERE order_id=$1
        `,
        [
          orderId
        ]
      );

    }

    catch (emailError) {

      console.error(
        'ERRO RESEND:',
        emailError
      );


      const errorText =
        emailError.message ||
        'Erro desconhecido no Resend.';


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


  return getOrder(
    orderId
  );

}


/* ========================================================
   LOCK
   ======================================================== */

const locks =
  new Map();


function fulfillLocked(
  orderId
) {

  if (
    locks.has(orderId)
  ) {

    return locks.get(
      orderId
    );

  }


  const promise =
    fulfillOrder(
      orderId
    )
      .catch(error => {

        console.error(
          'Emissão:',
          error
        );

        throw error;

      })
      .finally(() => {

        locks.delete(
          orderId
        );

      });


  locks.set(
    orderId,
    promise
  );


  return promise;

}


/* ========================================================
   HEALTH
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

        resend:
          Boolean(resend),

        emailFrom:
          Boolean(EMAIL_FROM),

        publicBaseUrl:
          Boolean(PUBLIC_BASE_URL),

        event:
          EVENT_NAME

      });

    }

    catch (e) {

      res.status(503).json({

        ok: false,

        error:
          e.message

      });

    }

  }
);


/* ========================================================
   PIX
   ======================================================== */

app.post(
  '/api/create-pix',
  async (req, res) => {

    try {

      const {
        buyer,
        items
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
        ).replace(
          /\D/g,
          ''
        );


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


      if (
        phone.length !== 11
      ) {

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
          `${EVENT_NAME} - ${normalized
            .map(
              item =>
                `${item.quantity}x ${item.name}`
            )
            .join(', ')}`,

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


      const transaction =
        payment
          .point_of_interaction
          ?.transaction_data;


      if (
        !transaction?.qr_code ||
        !transaction?.qr_code_base64
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
          transaction.qr_code,

        qrCodeBase64:
          transaction.qr_code_base64

      });

    }

    catch (e) {

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

    }

    catch (e) {

      console.error(
        'Status pagamento:',
        e
      );


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


      if (!paymentId) return;


      const payment =
        await mpRequest(
          `https://api.mercadopago.com/v1/payments/${encodeURIComponent(
            paymentId
          )}`
        );


      const orderId =
        payment.external_reference;


      if (!orderId) return;


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

    catch (e) {

      console.error(
        'Webhook Mercado Pago:',
        e
      );

    }

  }
);


/* ========================================================
   VALIDAR INGRESSO
   ======================================================== */

app.post(
  '/api/tickets/validate',
  requireAdmin,
  async (req, res) => {

    try {

      let token =
        String(
          req.body?.token || ''
        ).trim();


      /*
       * Se alguém mandar a URL completa
       * em vez do token, extraímos o ticket.
       */

      try {

        if (
          token.startsWith('http://') ||
          token.startsWith('https://')
        ) {

          const url =
            new URL(token);


          const ticket =
            url.searchParams.get(
              'ticket'
            );


          if (ticket) {

            token =
              decodeURIComponent(
                ticket
              ).trim();

          }

        }

      }

      catch {}


      if (!token) {

        return res.status(400).json({

          valid: false,

          error:
            'QR Code inválido.'

        });

      }


      console.log(
        'Validação recebida:',
        'tokenLength=',
        token.length
      );


      const tokenHash =
        hashToken(token);


      /*
       * PRIMEIRO TENTAMOS
       * ENCONTRAR O INGRESSO.
       */

      const result =
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
          [
            tokenHash
          ]
        );


      const ticket =
        result.rows[0];


      /*
       * DIAGNÓSTICO:
       * se não encontrou, mostramos
       * apenas informações seguras
       * no LOG do Render.
       */

      if (!ticket) {

        console.error(
          'INGRESSO NÃO ENCONTRADO:',
          {
            tokenLength:
              token.length,

            hashLength:
              tokenHash.length,

            hashPrefix:
              tokenHash.substring(
                0,
                10
              )
          }
        );


        return res.status(404).json({

          valid: false,

          error:
            'Ingresso não encontrado.'

        });

      }


      if (
        ticket.order_status !==
        'approved'
      ) {

        return res.status(400).json({

          valid: false,

          error:
            'Pagamento não aprovado.'

        });

      }


      if (
        ticket.used_at
      ) {

        return res.status(409).json({

          valid: false,

          used: true,

          error:
            'Este ingresso já foi utilizado.',

          ticket: {

            ticketId:
              ticket.ticket_id,

            batchName:
              ticket.batch_name,

            buyerName:
              ticket.buyer_name,

            usedAt:
              ticket.used_at

          }

        });

      }


      /*
       * MARCA COMO UTILIZADO
       * SOMENTE SE AINDA NÃO FOI USADO.
       */

      const used =
        await db(
          `
            UPDATE tickets
            SET used_at=NOW()
            WHERE ticket_id=$1
              AND used_at IS NULL
            RETURNING used_at
          `,
          [
            ticket.ticket_id
          ]
        );


      if (!used.rows[0]) {

        return res.status(409).json({

          valid: false,

          used: true,

          error:
            'Este ingresso já foi utilizado.'

        });

      }


      return res.json({

        valid: true,

        used: false,

        message:
          'Entrada liberada.',

        ticket: {

          ticketId:
            ticket.ticket_id,

          batchName:
            ticket.batch_name,

          buyerName:
            ticket.buyer_name

        }

      });

    }

    catch (e) {

      console.error(
        'Validação:',
        e
      );


      res.status(500).json({

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


      let tickets =
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


        tickets =
          await getTickets(
            order.orderId
          );

      }


      const freshOrder =
        await getOrder(
          order.orderId
        );


      await sendTicketEmail(
        freshOrder,
        tickets,
        true
      );


      await db(
        `
          UPDATE orders
          SET
            email_sent_at=NOW(),
            email_error=NULL,
            updated_at=NOW()
          WHERE order_id=$1
        `,
        [
          order.orderId
        ]
      );


      res.json({

        ok: true,

        message:
          'Ingressos reenviados.'

      });

    }

    catch (e) {

      console.error(
        'Reenvio:',
        e
      );


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

      const approved =
        await db(
          `
            SELECT
              COUNT(*)::int AS n
            FROM orders
            WHERE status='approved'
          `
        );


      const tickets =
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
        tickets.rows[0].n;


      const used =
        tickets.rows[0].used;


      res.json({

        approvedOrders:
          approved.rows[0].n,

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

    }

    catch (e) {

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
        ).replace(
          /\D/g,
          ''
        );


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


      if (
        cpf.length !== 11
      ) {

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
            $1,
            $2,
            'approved',
            $3,
            $4,
            $5,
            $6,
            $7,
            $8
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

          JSON.stringify([
            item
          ])

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
          tickets.map(
            ticket => ({

              ticketId:
                ticket.ticket_id,

              batchName:
                ticket.batch_name,

              usedAt:
                ticket.used_at

            })
          )

      });

    }

    catch (e) {

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

    }

    catch (e) {

      console.error(
        'Excluir testes:',
        e
      );


      res.status(500).json({

        error:
          e.message ||
          'Não foi possível excluir os testes.'

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
   INICIAR
   ======================================================== */

initDb()

  .then(() => {

    app.listen(
      PORT,
      '0.0.0.0',
      () => {

        console.log(
          `${EVENT_NAME} rodando na porta ${PORT}`
        );

        console.log(
          'Resend:',
          Boolean(resend)
        );

        console.log(
          'EMAIL_FROM:',
          Boolean(EMAIL_FROM)
        );

        console.log(
          'PUBLIC_BASE_URL:',
          PUBLIC_BASE_URL || '(não configurado)'
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
