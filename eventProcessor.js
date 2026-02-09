const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================
   UTIL: PAID_AT
========================= */
function extractPaidAt(payload) {
  const bill = payload?.event?.data?.bill;

  // prioridade absoluta
  const chargePaidAt = bill?.charges?.[0]?.paid_at;
  if (chargePaidAt) {
    return new Date(chargePaidAt);
  }

  // fallback
  if (bill?.paid_at) {
    return new Date(bill.paid_at);
  }

  return null;
}

/* =========================
   PROCESSOR
========================= */
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
      if (!data) {
        await pool.query(
          `UPDATE events SET processed = TRUE WHERE id = $1`,
          [event.id]
        );
        continue;
      }

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

      if (
        event.event_type === "subscription_created" &&
        data.subscription
      ) {
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
              data.subscription.status || "active",
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
              data.subscription.status || "active",
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
          event.event_type === "bill_paid" ||
          event.event_type === "import_bill") &&
        data.bill
      ) {
        const billId = data.bill.id;
        const paidAt = extractPaidAt(event.payload);

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
              due_at,
              created_at,
              paid_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            `,
            [
              billId,
              customerId,
              data.bill.bill_items?.[0]?.product?.name || null,
              data.bill.amount ? Number(data.bill.amount) : null,
              data.bill.status || null,
              data.bill.due_at ? new Date(data.bill.due_at) : null,
              data.bill.created_at
                ? new Date(data.bill.created_at)
                : new Date(),
              paidAt,
            ]
          );
        } else {
          await pool.query(
            `
            UPDATE bills
            SET
              status = $1,
              paid_at = $2
            WHERE vindi_bill_id = $3
            `,
            [
              data.bill.status || null,
              paidAt,
              billId,
            ]
          );
        }
      }

      /* =========================
         MARK AS PROCESSED
      ========================= */

      await pool.query(
        `UPDATE events SET processed = TRUE WHERE id = $1`,
        [event.id]
      );

      console.log(`✅ Evento ${event.id} processado`);
    } catch (err) {
      console.error(
        `❌ Erro ao processar evento ${event.id}:`,
        err.message
      );
    }
  }
}

module.exports = { runProcessor };
