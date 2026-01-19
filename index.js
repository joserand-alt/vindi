const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ==============================
// FUNÇÕES AUXILIARES
// ==============================
function normalizeTag(value) {
  if (!value) return null;
  return value.toString().trim().toLowerCase();
}

async function sendToRD(email, name, tags) {
  try {
    // tenta buscar o contato
    await axios.get(
      `https://api.rd.services/platform/contacts/email:${email}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.RD_API_TOKEN}`
        }
      }
    );

    // contato existe → adiciona tags
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

    console.log("RD: tags adicionadas");
  } catch (error) {
    if (error.response && error.response.status === 404) {
      // contato não existe → cria
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

      console.log("RD: contato criado");
    } else {
      console.error(
        "ERRO AO ENVIAR PARA RD:",
        error.response?.data || error.message
      );
    }
  }
}

// ==============================
// WEBHOOK DA VINDI
// ==============================
app.post("/webhook/vindi", async (req, res) => {
  try {
    const eventType = req.body?.event?.type;
    const data = req.body?.event?.data;

    console.log("EVENTO RECEBIDO:", eventType);

    // eventos que vamos tratar
    const allowedEvents = [
      "subscription_created",
      "bill_created",
      "bill_paid"
    ];

    if (!allowedEvents.includes(eventType)) {
      console.log("EVENTO IGNORADO:", eventType);
      return res.status(200).send("ignored");
    }

    // tenta achar o customer em diferentes estruturas
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

    // tenta extrair produto
    let productName = null;
    if (data?.bill?.bill_items?.length > 0) {
      productName = data.bill.bill_items[0]?.product?.name || null;
    }

    const tags = [
      normalizeTag(eventType.replace("_", "-")),
      normalizeTag(productName)
    ].filter(Boolean);

    console.log("EMAIL:", email);
    console.log("TAGS:", tags);

    await sendToRD(email, name, tags);

    return res.status(200).send("ok");
  } catch (err) {
    console.error("ERRO NO WEBHOOK:", err.message);
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


