const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // obrigatório no Render
});

async function saveEventAsync(event) {
  try {
    const client = await pool.connect();

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
        event.productName,
        event.conversion,
        event.status,
        event.payload,
      ]
    );

    client.release();
    console.log("💾 Evento salvo no banco com sucesso");
  } catch (err) {
    console.error("❌ ERRO AO SALVAR NO BANCO:", err.message);
  }
}

module.exports = { saveEventAsync };

