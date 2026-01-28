const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function runProcessor() {
  console.log("⚙️ Iniciando eventProcessor...");

  const { rows } = await pool.query(`
    SELECT *
    FROM events
    WHERE processed IS NOT TRUE
    ORDER BY id ASC
    LIMIT 20
  `);

  if (rows.length === 0) {
    console.log("ℹ️ Nenhum evento pendente");
    return;
  }

  for (const event of rows) {
    try {
      const data = event.payload?.event?.data;
      if (!data) continue;

      const customer =
        data.subscription?.customer ||
        data.bill?.customer ||
        null;

      if (customer?.email) {
        await pool.query(
          `
          INSERT INTO customers (email, name)
          VALUES ($1, $2)
          ON CONFLICT (email)
          DO UPDATE SET name = EXCLUDED.name
          `,
          [customer.email, customer.name || null]
        );
      }

      if (event.event_type === "subscription_created") {
        await pool.query(
          `
          INSERT INTO subscriptions (vindi_id, customer_email, product_name, status)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (vindi_id)
          DO UPDATE SET status = EXCLUDED.status
          `,
          [
            data.subscription.id,
            customer.email,
            data.subscription.plan?.name || null,
            "ativa",
          ]
        );
      }

      if (event.event_type === "bill_created" || event.event_type === "bill_paid") {
        await pool.query(
          `
          INSERT INTO bills (vindi_id, customer_email, amount, status, due_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (vindi_id)
          DO UPDATE SET status = EXCLUDED.status
          `,
          [
            data.bill.id,
            data.bill.customer.email,
            data.bill.amount,
            data.bill.status,
            data.bill.due_at,
          ]
        );
      }

      await pool.query(
        `UPDATE events SET processed = TRUE WHERE id = $1`,
        [event.id]
      );

      console.log(`✅ Evento ${event.id} processado`);
    } catch (err) {
      console.error(`❌ Erro ao processar evento ${event.id}`, err.message);
    }
  }
}

module.exports = { runProcessor };

