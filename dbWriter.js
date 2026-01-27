// dbWriter.js
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function saveEventAsync(data) {
  try {
    await pool.query(
      `
      INSERT INTO events (
        event_type,
        email,
        product_name,
        conversion,
        status,
        raw_payload
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        data.eventType,
        data.email,
        data.productName,
        data.conversion,
        data.status,
        JSON.stringify(data.payload)
      ]
    );

    console.log("💾 Evento salvo no banco");
  } catch (err) {
    console.error("❌ ERRO AO SALVAR NO BANCO:", err.message);
    // NÃO relança erro
  }
}

module.exports = { saveEventAsync };
