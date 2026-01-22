const { Pool } = require("pg");

/**
 * Pool único para toda a aplicação
 * NÃO criar pool dentro de função
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

/**
 * Função pública
 * NÃO usar await nela
 * NÃO lançar erro para fora
 */
function saveEventAsync(payload) {
  // Executa fora do fluxo principal
  setImmediate(async () => {
    try {
      await persistEvent(payload);
    } catch (err) {
      console.error("🛑 ERRO AO SALVAR NO BANCO:", err.message);
    }
  });
}

/**
 * Persistência real
 */
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
    dueAt,
  } = data;

  if (!email) {
    console.log("ℹ️ DB: email ausente, ignorando");
    return;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* ==========================
       CUSTOMER
    ========================== */
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

    /* ==========================
       SUBSCRIPTION
    ========================== */
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
          status || "active",
        ]
      );
    }

    /* ==========================
       BILL
    ========================== */
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
          amount || null,
          status || null,
          dueAt ? new Date(dueAt) : null,
        ]
      );
    }

    await client.query("COMMIT");

    console.log("✅ DB: evento salvo com sucesso");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  saveEventAsync,
};
