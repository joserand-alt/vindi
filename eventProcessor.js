const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   HELPERS
========================================================= */

async function upsertCustomer({ email, name }) {
  await pool.query(
    `
    INSERT INTO customers (email, name)
    VALUES ($1, $2)
    ON CONFLICT (email)
    DO UPDATE SET name = EXCLUDED.name
    `,
    [email, name || null]
  );
}

async function upsertSubscription({ vindiId, email, productName, status }) {
  await pool.query(
    `
    INSERT INTO subscriptions (vindi_id, customer_email, product_name, status)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (vindi_id)
    DO UPDATE SET status = EXCLUDED.status
    `,
    [vindiId, email, productName, status]
  );
}

async function upsertBill({ vindiId, email, amount, status, dueAt }) {
  await pool.query(
    `
    INSERT INTO bills (vindi_id, customer_email, amount, status, due_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (vindi_id)
    DO UPDATE SET status = EXCLUDED.status
    `,
    [vindiId, email, amount, status, dueAt]
  );
}

/* =========================================================
   PROCESSADOR PRINCIPAL
========================================================= */

async function processEvent(event) {
  const { event_type, payload } = event;

  const data = payload?.event?.data;

  if (!data) return;

  // CUSTOMER
  const customer =
    data.subscription?.customer ||
    data.bill?.customer ||
    data.customer;

  if (customer?.email) {
    await upsertCustomer({
      email: customer.email,
      name: customer.name,
    });
  }

  // SUBSCRIPTION
  if (event_type === "subscription_created") {
    await upsertSubscription({
      vindiId: data.subscription.id,
      email: customer.email,
      productName: data.subscription.plan?.name || null,
      status: "ativa",
    });
  }

  // BILL CREATED
  if (event_type === "bill_created") {
    const bill = data.bill;

    await upsertBill({
      vindiId: bill.id,
      email: bill.customer.email,
      amount: bill.amount,
      status: bill.status,
      dueAt: bill.due_at,
    });
  }

  // BILL PAID
  if (event_type === "bill_paid") {
    const bill = data.bill;

    await upsertBill({
      vindiId: bill.id,
      email: bill.customer.email,
      amount: bill.amount,
      status: "pago",
      dueAt: bill.due_at,
    });
  }
}

/* =========================================================
   LOOP DE PROCESSAMENTO
========================================================= */

async function runProcessor() {
  console.log("⚙️ Iniciando eventProcessor...");

  const { rows } = await pool.query(
    `
    SELECT *
    FROM events
    WHERE processed IS NOT TRUE
    ORDER BY id ASC
    LIMIT 50
    `
  );

  for (const event of rows) {
    try {
      await processEvent(event);

      await pool.query(
        `UPDATE events SET processed = TRUE WHERE id = $1`,
        [event.id]
      );

      console.log(`✅ Evento ${event.id} processado`);
    } catch (err) {
      console.error(`❌ Erro ao processar evento ${event.id}`, err.message);
    }
  }

  console.log("🏁 Ciclo finalizado");
}

module.exports = { runProcessor };
