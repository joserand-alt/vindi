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
      const data = event.payload?.event?.data;
      if (!data) continue;

      /* =========================
         CUSTOMER
      ========================= */

      const customer =
        data.subscription?.customer ||
        data.bill?.customer ||
        null;

      let customerId = null;

      if (customer?.email) {
        const existingCustomer = await pool.query(
          `SELECT id FROM customers WHERE email = $1`,
          [customer.email]
        );

        if (existingCustomer.rows.length === 0) {
          const insertCustomer = await pool.query(
            `
            INSERT INTO customers (vindi_customer_id, name, email)
            VALUES ($1, $2, $3)
            RETURNING id
            `,
            [
              customer.id || null,
              customer.name || null,
              customer.email,
            ]
          );
          customerId = insertCustomer.rows[0].id;
        } else {
          customerId = existingCustomer.rows[0].id;

          await pool.query(
            `
            UPDATE customers
            SET name = $1
            WHERE id = $2
            `,
            [customer.name || null, customerId]
          );
        }
      }

      /* =========================
         SUBSCRIPTION
      ========================= */

      if (event.event_type === "subscription_created" && data.subscription) {
        const subscriptionId = data.subscription.id;

        const existingSubscription = await pool.query(
          `SELECT id FROM subscriptions WHERE vindi_subscription_id = $1`,
          [subscriptionId]
        );

        if (existingSubscription.rows.length === 0) {
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
            `,
            [
              subscriptionId,
              customerId,
              data.subscription.plan?.name || null,
              data.subscription.plan?.name || null,
              data.subscription.status || "ativa",
            ]
          );
        } else {
          await pool.query(
            `
            UPDATE subscriptions
            SET status = $1
            WHERE vindi_subscription_id = $2
            `,
            [
              data.subscription.status || "ativa",
              subscriptionId,
            ]
          );
        }
      }

      /* =========================
         BILL
      ========================= */

      if (
        (event.event_type === "bill_created" ||
          event.event_type === "bill_paid") &&
        data.bill
      ) {
        const billId = data.bill.id;

        const existingBill = await pool.query(
          `SELECT id FROM bills WHERE vindi_bill_id = $1`,
          [billId]
        );

        if (existingBill.rows.length === 0) {
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
            `,
            [
              billId,
              customerId,
              data.bill.bill_items?.[0]?.product?.name || null,
              data.bill.amount || null,
              data.bill.status || null,
              data.bill.due_at || null,
            ]
          );
        } else {
          await pool.query(
            `
            UPDATE bills
            SET status = $1
            WHERE vindi_bill_id = $2
            `,
            [data.bill.status || null, billId]
          );
        }
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

