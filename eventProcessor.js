const { Pool } = require("pg");

/* ============================
   CONEXÃO COM BANCO
============================ */
const pool = new Pool({
  host: "dpg-d5km3n4oud1c73ds5q3g-a.virginia-postgres.render.com",
  port: 5432,
  user: "dbvindi_user",
  password: "3s1nNlgBMUkLLeOK0J8ZSDlUtBzVAuON",
  database: "dbvindi",
  ssl: { rejectUnauthorized: false }
});

/* ============================
   HELPERS DE DATA
============================ */
function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function extractPaidAt(payload) {
  const bill = payload?.event?.data?.bill;
  if (!bill) return null;

  return (
    safeDate(bill?.charges?.[0]?.paid_at) ||
    safeDate(bill?.paid_at)
  );
}

function extractSubscriptionCreatedAt(payload) {
  const event = payload?.event;

  return (
    safeDate(event?.data?.subscription?.created_at) ||
    safeDate(event?.data?.bill?.subscription?.created_at) ||
    safeDate(event?.created_at)
  );
}

/* ============================
   PROCESSADOR PRINCIPAL
============================ */
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

        /* ============================
           CUSTOMER
        ============================ */
        const customer =
          data.subscription?.customer ||
          data.bill?.customer ||
          null;

        let customerId = null;

        if (customer?.email) {
          const existing = await client.query(
            `SELECT id FROM customers WHERE email = $1`,
            [customer.email]
          );

          if (existing.rows.length === 0) {
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
            customerId = existing.rows[0].id;
          }
        }

        /* ============================
           SUBSCRIPTION
        ============================ */
        if (data.subscription) {
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
              data.subscription.id,
              customerId,
              data.subscription.plan?.name || null,
              data.subscription.plan?.name || null,
              data.subscription.status || null,
              extractSubscriptionCreatedAt(payload)
            ]
          );
        }

        /* ============================
           BILL
        ============================ */
        if (data.bill) {
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
              data.bill.id,
              data.bill.subscription?.id || null,
              customerId,
              data.bill.bill_items?.[0]?.product?.name || null,
              data.bill.amount ? Number(data.bill.amount) : null,
              data.bill.status || null,
              safeDate(data.bill.due_at),
              safeDate(data.bill.created_at) || new Date(),
              extractPaidAt(payload)
            ]
          );
        }

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

/* ============================
   EXPORTS (COMPATÍVEL COM INDEX)
============================ */
module.exports = {
  runEventProcessor,
  runProcessor: runEventProcessor
};
