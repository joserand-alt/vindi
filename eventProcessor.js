const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function runProcessor() {
  console.log("⚙️ Iniciando eventProcessor...");

  const { rows: events } = await pool.query(`
    SELECT *
    FROM events
    WHERE processed IS NOT TRUE
    ORDER BY id ASC
    LIMIT 20
  `);

  if (events.length === 0) {
    console.log("ℹ️ Nenhum evento pendente");
    return;
  }

  for (const event of events) {
    try {
      const payload = event.payload?.event?.data;
      if (!payload) continue;

      /* =========================
         CUSTOMER
      ========================= */

      const customer =
        payload.subscription?.customer ||
        payload.bill?.customer ||
        null;

      let customerId = null;

      if (customer?.email) {
        const { rows } = await pool.query(
          `
          INSERT INTO customers (vindi_customer_id, name, email)
          VALUES ($1, $2, $3)
          ON CONFLICT (email)
          DO UPDATE SET name = EXCLUDED.name
          RETURNING id
          `,
          [
            customer.id || null,
            customer.name || null,
            customer.email,
          ]
        );

        customerId = rows[0].id;
      }

      /* =========================
         SUBSCRIPTION
      ========================= */

      if (event.event_type === "subscription_created" && payload.subscription) {
        await pool.query(
          `
          INSERT INTO subscriptions (
            vindi_subscription_id,
            customer_id,
            product_name,
            plan_name,
            status
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (vindi_subscription_id)
          DO UPDATE SET status = EXCLUDED.status
          `,
          [
            payload.subscription.id,
            customerId,
            payload.subscription.plan?.name || null,
            payload.subscription.plan?.name || null,
            payload.subscription.status || "ativa",
          ]
        );
      }

      /* =========================
         BILL
      ========================= */

      if (
        (event.event_type === "bill_created" ||
          event.event_type === "bill_paid") &&
        payload.bill
      ) {
        await pool.query(
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
          ON CONFLICT (vindi_bill_id)
          DO UPDATE SET status = EXCLUDED.status
          `,
          [
            payload.bill.id,
            customerId,
            payload.bill.bill_items?.[0]?.product?.name || null,
            payload.bill.amount || null,
            payload.bill.status || null,
            payload.bill.due_at || null,
          ]
        );
      }

      /* =========================
         MARK EVENT AS PROCESSED
      ========================= */

      await pool.query(
        `UPDATE events SET processed = TRUE WHERE id = $1`,
        [event.id]
      );

      console.log(`✅ Evento ${event.id} processado com sucesso`);
    } catch (err) {
      console.error(
        `❌ Erro ao processar evento ${event.id}:`,
        err.message
      );
    }
  }
}

module.exports = { runProcessor };

