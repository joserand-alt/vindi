require("dotenv").config();
const { Pool } = require("pg");

/* =====================================================
   CONEXÃO COM O BANCO
===================================================== */

const pool = new Pool({
  host: "dpg-d5km3n4oud1c73ds5q3g-a.virginia-postgres.render.com",
  port: 5432,
  user: "dbvindi_user",
  password: "3s1nNlgBMUkLLeOK0J8ZSDlUtBzVAuON",
  database: "dbvindi",
  ssl: { rejectUnauthorized: false }
});

/* =====================================================
   HELPERS
===================================================== */

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function extractPaidAt(payload) {
  const bill = payload?.event?.data?.bill;
  if (!bill) return null;

  // prioridade absoluta
  const fromCharge = bill?.charges?.[0]?.paid_at;
  if (fromCharge) return safeDate(fromCharge);

  // fallback
  return safeDate(bill?.paid_at);
}

function extractSubscriptionCreatedAt(payload) {
  const event = payload?.event;

  return (
    safeDate(event?.data?.subscription?.created_at) ||
    safeDate(event?.data?.bill?.subscription?.created_at) ||
    safeDate(event?.created_at)
  );
}

/* =====================================================
   PROCESSADOR PRINCIPAL
===================================================== */

async function runEventProcessor() {
  console.log("⚙️ EventProcessor rodando...");

  const client = await pool.connect();

  try {
    const { rows: events } = await client.query(`
      SELECT *
      FROM events
      WHERE processed IS NOT TRUE
      ORDER BY id
      LIMIT 50
    `);

    if (events.length === 0) {
      console.log("ℹ️ Nenhum evento pendente");
      return;
    }

    for (const row of events) {
      try {
        const payload = row.payload;
        const event = payload?.event;
        const data = event?.data;

        if (!data) {
          await client.query(
            `UPDATE events SET processed = TRUE WHERE id = $1`,
            [row.id]
          );
          continue;
        }

        /* ===============================
           CUSTOMER
        =============================== */

        const customer =
          data.subscription?.customer ||
          data.bill?.customer ||
          null;

        let customerId = null;

        if (customer?.email) {
          const existingCustomer = await client.query(
            `SELECT id FROM customers WHERE email = $1`,
            [customer.email]
          );

          if (existingCustomer.rows.length === 0) {
            const inserted = await client.query(
              `
              INSERT INTO customers (vindi_customer_id, name, email)
              VALUES ($1,$2,$3)
              RETURNING id
              `,
              [
                customer.id || null,
                customer.name || null,
                customer.email
              ]
            );
            customerId = inserted.rows[0].id;
          } else {
            customerId = existingCustomer.rows[0].id;

            await client.query(
              `UPDATE customers SET name = $1 WHERE id = $2`,
              [customer.name || null, customerId]
            );
          }
        }

        /* ===============================
           SUBSCRIPTION
        =============================== */

        if (data.subscription) {
          const subscriptionId = data.subscription.id;
          const createdAt = extractSubscriptionCreatedAt(payload);

          await client.query(
            `
            INSERT INTO subscriptions (
              vindi_subscription_id,
              customer_id,
              product_name,
              plan_name,
              status,
              created_at
            )
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (vindi_subscription_id)
            DO UPDATE SET
              status = EXCLUDED.status,
              created_at = COALESCE(
                subscriptions.created_at,
                EXCLUDED.created_at
              )
            `,
            [
              subscriptionId,
              customerId,
              data.subscription.plan?.name || null,
              data.subscription.plan?.name || null,
              data.subscription.status || null,
              createdAt
            ]
          );
        }

        /* ===============================
           BILL
        =============================== */

        if (data.bill) {
          const bill = data.bill;
          const paidAt = extractPaidAt(payload);

          await client.query(
            `
            INSERT INTO bills (
              vindi_bill_id,
              vindi_subscription_id,
              customer_id,
              product_name,
              amount,
              status,
              due_at,
              created_at,
              paid_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT (vindi_bill_id)
            DO UPDATE SET
              status = EXCLUDED.status,
              paid_at = EXCLUDED.paid_at,
              vindi_subscription_id = COALESCE(
                bills.vindi_subscription_id,
                EXCLUDED.vindi_subscription_id
              )
            `,
            [
              bill.id,
              bill.subscription?.id || null,
              customerId,
              bill.bill_items?.[0]?.product?.name || null,
              bill.amount ? Number(bill.amount) : null,
              bill.status || null,
              safeDate(bill.due_at),
              safeDate(bill.created_at) || new Date(),
              paidAt
            ]
          );
        }

        /* ===============================
           FINALIZA EVENTO
        =============================== */

        await client.query(
          `UPDATE events SET processed = TRUE WHERE id = $1`,
          [row.id]
        );

        console.log(`✅ Evento ${row.id} processado`);
      } catch (err) {
        console.error(`❌ Erro no evento ${row.id}:`, err.message);
      }
    }
  } finally {
    client.release();
  }
}

module.exports = { runEventProcessor };
