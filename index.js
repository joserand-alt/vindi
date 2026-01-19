const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// ======================================================
// POSTGRESQL
// ======================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ======================================================
// RD OAUTH
// ======================================================
async function getAccessToken() {
  const params = new URLSearchParams();
  params.append("client_id", process.env.RD_CLIENT_ID);
  params.append("client_secret", process.env.RD_CLIENT_SECRET);
  params.append("refresh_token", process.env.RD_REFRESH_TOKEN);
  params.append("grant_type", "refresh_token");

  const response = await axios.post(
    "https://api.rd.services/auth/token",
    params.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  return response.data.access_token;
}

// ======================================================
// DATABASE HELPERS
// ======================================================
async function upsertCustomer({ vindiId, name, email }) {
  const result = await pool.query(
    `
    INSERT INTO customers (vindi_customer_id, name, email)
    VALUES ($1, $2, $3)
    ON CONFLICT (email)
    DO UPDATE SET name = EXCLUDED.name
    RETURNING id
    `,
    [vindiId, name, email]
  );
  return result.rows[0].id;
}

async function insertSubscription({ vindiId, customerId, productName, status, createdAt }) {
  await pool.query(
    `
    INSERT INTO subscriptions
    (vindi_subscription_id, customer_id, product_name, status, created_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT DO NOTHING
    `,
    [vindiId, customerId, productName, status, createdAt]
  );
}

async function insertBill({ vindiId, customerId, productName, amount, status, dueAt, createdAt }) {
  await pool.query(
    `
    INSERT INTO bills
    (vindi_bill_id, customer_id, product_name, amount, status, due_at, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT DO NOTHING
    `,
    [vindiId, customerId, productName, amount, status, dueAt, createdAt]
  );
}

async function insertCharge({ vindiId, billId, amount, status, method, paidAt, createdAt }) {
  await pool.query(
    `
    INSERT INTO charges
    (vindi_charge_id, bill_id, amount, status, payment_method, paid_at, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT DO NOTHING
    `,
    [vindiId, billId, amount, status, method, paidAt, createdAt]
  );
}

// ======================================================
// RD HELPERS
// ======================================================
async function updateRDContact({ email, name, tags }) {
  const token = await getAccessToken();

  await axios.patch(
    `https://api.rd.services/platform/contacts/email:${email}`,
    {
      name,
      tags: tags.map(t => t.toLowerCase())
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    }
  );

  console.log("RD ATUALIZADO:", email, tags);
}

// ======================================================
// WEBHOOK VINDI
// ======================================================
app.post("/webhook/vindi", async (req, res) => {
  try {
    const payload = req.body;
    const eventType = payload?.event?.type;

    console.log("EVENTO RECEBIDO:", eventType);

    // ===============================
    // ASSINATURA CRIADA
    // ===============================
    if (eventType === "subscription_created") {
      const subscription = payload.event.data.subscription;
      const customer = subscription.customer;

      const customerId = await upsertCustomer({
        vindiId: customer.id,
        name: customer.name,
        email: customer.email
      });

      const productName =
        subscription.plan?.name ||
        subscription.product?.name ||
        null;

      await insertSubscription({
        vindiId: subscription.id,
        customerId,
        productName,
        status: subscription.status,
        createdAt: subscription.created_at
      });

      await updateRDContact({
        email: customer.email,
        name: customer.name,
        tags: ["assinatura-criada-vindi", productName || "assinatura"]
      });
    }

    // ===============================
    // COBRANÇA CRIADA
    // ===============================
    if (eventType === "bill_created") {
      const bill = payload.event.data.bill;
      const customer = bill.customer;

      const customerId = await upsertCustomer({
        vindiId: customer.id,
        name: customer.name,
        email: customer.email
      });

      const productName =
        bill.bill_items?.[0]?.product?.name || null;

      await insertBill({
        vindiId: bill.id,
        customerId,
        productName,
        amount: bill.amount,
        status: bill.status,
        dueAt: bill.due_at,
        createdAt: bill.created_at
      });

      await updateRDContact({
        email: customer.email,
        name: customer.name,
        tags: ["cobranca-gerada-vindi", productName || "cobranca"]
      });
    }

    // ===============================
    // TENTATIVA DE PAGAMENTO
    // ===============================
    if (eventType === "charge_created") {
      const charge = payload.event.data.charge;
      const billId = payload.event.data.bill?.id;

      if (!billId) return res.status(200).send("ok");

      const billResult = await pool.query(
        `SELECT id FROM bills WHERE vindi_bill_id = $1`,
        [billId]
      );

      if (billResult.rows.length === 0) return res.status(200).send("ok");

      await insertCharge({
        vindiId: charge.id,
        billId: billResult.rows[0].id,
        amount: charge.amount,
        status: charge.status,
        method: charge.payment_method?.code,
        paidAt: null,
        createdAt: charge.created_at
      });
    }

    // ===============================
    // PAGAMENTO CONFIRMADO (PRINCIPAL)
    // ===============================
    if (eventType === "bill_paid") {
      const bill = payload.event.data.bill;

      const billResult = await pool.query(
        `SELECT id FROM bills WHERE vindi_bill_id = $1`,
        [bill.id]
      );

      if (billResult.rows.length === 0) return res.status(200).send("ok");

      await insertCharge({
        vindiId: bill.id,
        billId: billResult.rows[0].id,
        amount: bill.amount,
        status: "paid",
        method: bill.payment_profile?.payment_method?.code || null,
        paidAt: bill.updated_at,
        createdAt: bill.created_at
      });
    }

    // ===============================
    // PAGAMENTO CONFIRMADO (FALLBACK)
    // ===============================
    if (eventType === "charge_paid") {
      const charge = payload.event.data.charge;
      const billId = payload.event.data.bill?.id;

      if (!billId) return res.status(200).send("ok");

      const billResult = await pool.query(
        `SELECT id FROM bills WHERE vindi_bill_id = $1`,
        [billId]
      );

      if (billResult.rows.length === 0) return res.status(200).send("ok");

      await insertCharge({
        vindiId: charge.id,
        billId: billResult.rows[0].id,
        amount: charge.amount,
        status: "paid",
        method: charge.payment_method?.code,
        paidAt: charge.paid_at,
        createdAt: charge.created_at
      });
    }

    return res.status(200).send("ok");
  } catch (error) {
    console.error("ERRO WEBHOOK:", error);
    return res.status(200).send("erro tratado");
  }
});

// ======================================================
// HEALTHCHECK
// ======================================================
app.get("/", (req, res) => {
  res.send("online");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Webhook rodando");
});

