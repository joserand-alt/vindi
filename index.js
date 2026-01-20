const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

/* ===============================
   CONFIGURAÇÕES
================================ */

const RD_EVENTS_URL = "https://api.rd.services/platform/events";

// pool do banco (não trava o webhook se cair)
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

/* ===============================
   REGRAS DE CONVERSÃO
================================ */

const CONVERSION_RULES = [
  { terms: ["ortoped"], base: "pos-graduacao-orto" },
  { terms: ["inunodeprimido", "imunodeprimido", "imunodeprimidos"], base: "pos-graduacao-imuno" },
  { terms: ["infeccao hospitalar", "ccih"], base: "pos-graduacao-ccih" },
  { terms: ["pediatria"], base: "pos-graduacao-pediatria" },
  { terms: ["multi-r", "multir", "multi r"], base: "jornada-multi-r" }
];

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function resolveConversion(text) {
  if (!text) return null;
  const normalized = normalize(text);

  for (const rule of CONVERSION_RULES) {
    for (const term of rule.terms) {
      if (normalized.includes(term)) {
        return rule.base;
      }
    }
  }
  return null;
}

/* ===============================
   RD STATION
================================ */

async function sendConversionToRD(email, eventIdentifier) {
  await axios.post(
    RD_EVENTS_URL,
    {
      event_type: "CONVERSION",
      event_family: "CDP",
      payload: {
        conversion_identifier: eventIdentifier,
        email
      }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.RD_API_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

/* ===============================
   BANCO DE DADOS (SAFE)
================================ */

async function upsertCustomer(vindiCustomer) {
  if (!pool) return;

  try {
    await pool.query(
      `
      INSERT INTO customers (vindi_customer_id, name, email)
      VALUES ($1, $2, $3)
      ON CONFLICT (vindi_customer_id)
      DO NOTHING
      `,
      [vindiCustomer.id, vindiCustomer.name, vindiCustomer.email]
    );
  } catch (err) {
    console.error("ERRO AO SALVAR CUSTOMER:", err.message);
  }
}

async function saveSubscription(subscription, customerId) {
  if (!pool) return;

  try {
    await pool.query(
      `
      INSERT INTO subscriptions
      (vindi_subscription_id, customer_id, product_name, plan_name, status)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (vindi_subscription_id)
      DO NOTHING
      `,
      [
        subscription.id,
        customerId,
        subscription.plan?.product?.name || null,
        subscription.plan?.name || null,
        subscription.status
      ]
    );
  } catch (err) {
    console.error("ERRO AO SALVAR SUBSCRIPTION:", err.message);
  }
}

async function saveBill(bill, customerId) {
  if (!pool) return;

  try {
    await pool.query(
      `
      INSERT INTO bills
      (vindi_bill_id, customer_id, product_name, amount, status, due_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (vindi_bill_id)
      DO NOTHING
      `,
      [
        bill.id,
        customerId,
        bill.bill_items?.[0]?.product?.name || null,
        bill.amount,
        bill.status,
        bill.due_at
      ]
    );
  } catch (err) {
    console.error("ERRO AO SALVAR BILL:", err.message);
  }
}

/* ===============================
   WEBHOOK VINDI
================================ */

app.post("/webhook/vindi", async (req, res) => {
  try {
    const eventType = req.body?.event?.type;
    const data = req.body?.event?.data;

    console.log("EVENTO RECEBIDO:", eventType);

    if (!data?.customer?.email) {
      return res.status(200).send("Sem email");
    }

    const email = data.customer.email;
    const productText =
      data.subscription?.plan?.product?.name ||
      data.bill?.bill_items?.[0]?.product?.name ||
      "";

    const conversionBase = resolveConversion(productText);

    /* ================= RD ================= */

    if (conversionBase) {
      if (eventType === "subscription_created" || eventType === "bill_created") {
        await sendConversionToRD(email, `${conversionBase}-pendente`);
      }

      if (eventType === "bill_paid") {
        await sendConversionToRD(email, `${conversionBase}-pago`);
      }
    }

    /* ================= BANCO (SAFE) ================= */

    await upsertCustomer(data.customer);

    if (eventType === "subscription_created" && data.subscription) {
      await saveSubscription(data.subscription, data.customer.id);
    }

    if ((eventType === "bill_created" || eventType === "bill_paid") && data.bill) {
      await saveBill(data.bill, data.customer.id);
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("ERRO WEBHOOK:", err.message);
    return res.status(200).send("Erro tratado");
  }
});

/* ===============================
   START
================================ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Webhook rodando");
});

