const { Pool } = require("pg");
const { normalizeProductName } = require("./productNormalizer");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function saveEventAsync(event) {
  try {
    const client = await pool.connect();

    const normalizedProductName = normalizeProductName(event.productName);

    await client.query(
      `
      INSERT INTO events (
        event_type,
        email,
        product_name,
        conversion,
        status,
        payload
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        event.eventType,
        event.email,
        normalizedProductName,
        event.conversion,
        event.status,
        event.payload,
      ]
    );

    client.release();
    console.log("Evento salvo no banco com sucesso");
  } catch (err) {
    console.error("Erro ao salvar no banco:", err.message);
  }
}

module.exports = { saveEventAsync };