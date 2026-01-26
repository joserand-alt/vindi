const { Pool } = require("pg");

/* =========================================================
   POOL ÚNICO (CRIADO UMA VEZ)
========================================================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

/* =========================================================
   FUNÇÃO PÚBLICA (NÃO BLOQUEANTE)
========================================================= */

function saveEventAsync(data) {
  // executa fora do fluxo principal
  setImmediate(async () => {
    try {
      await persistEvent(data);
    } catch (err) {
      console.error("🛑 DBWRITER | erro ao persistir evento:", err.message);
    }
  });
}

/* =========================================================
   PERSISTÊNCIA REAL
========================================================= */

async function persistEvent(data) {
  const {
    eventType,
    email,
    name,
    vindiCustomerId,
    vindiSubscriptionId,
    vindiBillId,
    productName,
    planName,
    amount,
    status,
    dueAt
  } = data;

  if (!email) {
    console.log("ℹ️ DBWRITER | email ausente, ignorando");
    return;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* ===============================
       CUSTOMER
    =============================== */

    const customerResult = await client.query(
      `
      INSERT INTO customers (vindi_customer_id, name, email)
      VALUES ($1, $2, $3)
      ON CONFLICT (email)
      DO UPDATE SET
        name = EXCLUDED.name,
        vindi_customer_id = COALESCE(customers.vindi_customer_id, EXCLUDED.vindi_customer_id)
      RETURNING id
      `,
      [vindiCustomerId || null, name || null, email]
    );

    const customerId = customerResult.rows[0].id;

    /* ===============================
       SUBSCRIPTION
    =============================== */

    if (eventType === "subscription_created" && vindiSubscriptionId) {
      await client.query(
        `
        INSERT INTO subscriptions (
          vindi_subscription_id,
          customer_id,
          product_name,
          plan_name,
          status
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (vindi_subscription_id) DO NOTHING
        `,
        [
          vindiSubscriptionId,
          customerId,
          productName || null,
          planName || null,
          status || "active"
        ]
      );
    }

    /* ===============================
       BILL
    =============================== */

    if (eventType.startsWith("bill_") && vindiBillId) {
      await client.query(
        `
        INSERT INTO bills (
          vindi_bill_id,
          customer_id,
          product_name,
          amount,
          status,
          due_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (vindi_bill_id) DO NOTHING
        `,
        [
          vindiBillId,
          customerId,
          productName || null,
          amount ? Number(amount) : null,
          status || null,
          dueAt ? new Date(dueAt) : null
        ]
      );
    }

    await client.query("COMMIT");

    console.log("✅ DBWRITER | evento salvo com sucesso");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  saveEventAsync
};

