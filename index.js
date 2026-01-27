const express = require("express");
const axios = require("axios");
const { saveEventAsync } = require("./dbWriter");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

/* =========================================================
   RD STATION — OAuth
========================================================= */

let rdAccessToken = null;
let rdTokenExpiresAt = 0;

async function getRdAccessToken() {
  if (rdAccessToken && rdTokenExpiresAt > Date.now()) {
    return rdAccessToken;
  }

  console.log("🔄 Renovando access token da RD...");

  const response = await axios.post(
    "https://api.rd.services/auth/token",
    {
      client_id: process.env.RD_CLIENT_ID,
      client_secret: process.env.RD_CLIENT_SECRET,
      refresh_token: process.env.RD_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }
  );

  rdAccessToken = response.data.access_token;
  rdTokenExpiresAt = Date.now() + (response.data.expires_in - 60) * 1000;

  if (response.data.refresh_token) {
    console.log("⚠️ Novo refresh token gerado — ATUALIZE NO RENDER");
    console.log(response.data.refresh_token);
  }

  return rdAccessToken;
}

/* =========================================================
   MAPEAMENTO DE PRODUTOS → CONVERSÕES
========================================================= */

const conversionMap = [
  { match: "ortopéd", conversion: "Pós-graduação Orto" },
  { match: "inunodeprimido", conversion: "Pós-graduação Imuno" },
  { match: "imunodeprimido", conversion: "Pós-graduação Imuno" },
  { match: "infecção hospitalar", conversion: "Pós-graduação ccih" },
  { match: "ccih", conversion: "Pós-graduação ccih" },
  { match: "pediatria", conversion: "Pós-graduação Pediatria" },
  { match: "multi-r", conversion: "Jornada Multi-R" },
];

function resolveConversion(productName) {
  if (!productName) return null;
  const name = productName.toLowerCase();
  const found = conversionMap.find((item) => name.includes(item.match));
  return found ? found.conversion : null;
}

/* =========================================================
   HELPERS — EXTRAÇÃO VINDI
========================================================= */

function extractEmail(payload) {
  return (
    payload?.event?.data?.subscription?.customer?.email ||
    payload?.event?.data?.bill?.customer?.email ||
    null
  );
}

function extractProductName(payload) {
  return (
    payload?.event?.data?.bill?.bill_items?.[0]?.product?.name ||
    payload?.event?.data?.subscription?.plan?.name ||
    null
  );
}

/* =========================================================
   RD — CONTATO
========================================================= */

async function createOrUpdateContact(email) {
  const token = await getRdAccessToken();

  try {
    await axios.patch(
      `https://api.rd.services/platform/contacts/email:${email}`,
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    if (err.response?.status === 404) {
      await axios.post(
        "https://api.rd.services/platform/contacts",
        { email },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );
    } else {
      throw err;
    }
  }
}

/* =========================================================
   RD — CONVERSÃO
========================================================= */

async function sendConversion(email, conversionName) {
  const token = await getRdAccessToken();

  const identifier = conversionName
    .toLowerCase()
    .replace(/\s+/g, "-")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  console.log(`🚀 Enviando conversão para RD: ${identifier}`);

  await axios.post(
    "https://api.rd.services/platform/events",
    {
      event_type: "CONVERSION",
      event_family: "CDP",
      payload: {
        conversion_identifier: identifier,
        email,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );
}

/* =========================================================
   WEBHOOK VINDI
========================================================= */

app.post("/webhook/vindi", async (req, res) => {
  try {
    const eventType = req.body?.event?.type;
    console.log("📩 EVENTO RECEBIDO:", eventType);

    const email = extractEmail(req.body);
    if (!email) {
      console.log("⚠️ Email não encontrado, evento ignorado");
      return res.sendStatus(200);
    }

    const productName = extractProductName(req.body);
    console.log("📦 PRODUTO:", productName);

    const baseConversion = resolveConversion(productName);
    if (!baseConversion) {
      console.log("⚠️ Produto sem mapeamento, evento ignorado");
      return res.sendStatus(200);
    }

    // 🔹 RD (crítico)
    await createOrUpdateContact(email);

    let status = "pendente";

    if (eventType === "subscription_created" || eventType === "bill_created") {
      await sendConversion(email, `${baseConversion} - pendente`);
    }

    if (eventType === "bill_paid") {
      status = "pago";
      await sendConversion(email, `${baseConversion} - pago`);
    }

    // 🔹 BANCO (não crítico, sem await)
    saveEventAsync({
      eventType,
      email,
      productName,
      conversion: `${baseConversion} - ${status}`,
      status,
      payload: req.body,
    });

    console.log("✅ Webhook processado com sucesso");
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ ERRO WEBHOOK:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

/* =========================================================
   SERVER
========================================================= */

app.get("/", (_, res) => {
  res.send("Webhook Vindi → RD rodando");
});

app.listen(PORT, () => {
  console.log("🚀 Webhook rodando na porta", PORT);
});

