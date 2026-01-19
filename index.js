const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// ==============================
// POSTGRES
// ==============================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ==============================
// FUNÇÕES AUXILIARES
// ==============================
function normalizeTag(value) {
  if (!value) return null;
  return value.toString().trim().toLowerCase();
}

async function saveEventToDatabase(eventType, email, productName, payload) {
  try {
    await pool.query(
      `
      INSERT INTO webhook_events (
        event_type,
        email,
        product_name,
        payload
      )
      VALUES ($1, $2, $3, $4)
      `,
      [eventType, email, productName, payload]
    );

    console.log("EVENTO SALVO NO BANCO");
  } catch (err) {
    console.error("ERRO AO SALVAR NO BANCO:", err.message);
  }
}

async function sendToRD(email, name, tags) {
  try {
    // tenta buscar contato
    await axios.get(
      `https://api.rd.services/platform/contacts/email:${email}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.RD_API_TOKEN}`
        }
      }
    );

    // contato existe, adiciona tag
    await axios.post(
      `https://api.rd.services/platform/contacts/email:${email}/tag`,
      { tags },
      {
        headers: {
          Authorization: `Bearer ${process.env.RD_API_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("TAGS ATUALIZADAS NO RD");
  } catch (error) {
    if (error.response && error.response.status === 404) {
      // contato não existe, cria
      await axios.post(
        "https://api.rd.services/platform/contacts",
        {
          email,
          name,
          tags
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.RD_API_TOKEN}`,
            "Content-Type": "application/json"
          }
        }
      );

      console.log("CONTATO CRIADO NO RD");
    } else {
      console.error("ERRO AO ENVIAR PARA RD:", error.message);
    }
  }
}

// ==============================
// WEBHOOK
// ==============================
app.post("/webhook/vindi", async (req, res) => {
  try {
    const eventType = req.body?.event?.type;
    const data = req.body?.event?.data;

    console.log("EVENTO RECEBIDO:", eventType);

    if (!["subscription_created", "bill_created", "bill_paid"].includes(eventType)) {
      console.log("EVENTO IGNORADO:", eventType);
      return res.status(200).send("ignored");
    }

    const customer =
      data?.subscription?.customer ||
      data?.bill?.customer ||
      data?.charge?.customer;

    if (!customer?.email) {
      console.log("EMAIL NÃO ENCONTRADO");
      return res.status(200).send("no email");
    }

    const email = customer.email;
    const name = customer.name || "";

    let productName = null;

    if (data?.bill?.bill_items?.length > 0) {
      productName = data.bill.bill_items[0]?.product?.name || null;
    }

    const tags = [
      normalizeTag(eventType.replace("_", "-")),
      normalizeTag(productName)
    ].filter(Boolean);

    // salva no banco sem travar o fluxo
    saveEventToDatabase(eventType, email, productName, req.body);

    // envia para RD sem travar o fluxo
    sendToRD(email, name, tags);

    return res.status(200).send("ok");
  } catch (err) {
    console.error("ERRO WEBHOOK:", err.message);
    return res.status(200).send("error treated");
  }
});

// ==============================
// SERVER
// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Webhook rodando");
});


