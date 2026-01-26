const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

/* ===============================
   CONFIGURAÇÕES RD STATION
================================ */

const RD_TOKEN_URL = "https://api.rd.services/auth/token";
const RD_CONVERSION_URL = "https://api.rd.services/platform/conversions";

let rdAccessToken = null;
let rdTokenExpiresAt = 0;

async function getRdAccessToken() {
  if (rdAccessToken && rdTokenExpiresAt > Date.now()) {
    return rdAccessToken;
  }

  console.log("🔁 Renovando access token da RD...");

  const response = await axios.post(RD_TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: process.env.RD_CLIENT_ID,
    client_secret: process.env.RD_CLIENT_SECRET,
    refresh_token: process.env.RD_REFRESH_TOKEN
  });

  rdAccessToken = response.data.access_token;
  rdTokenExpiresAt = Date.now() + (response.data.expires_in - 60) * 1000;

  if (response.data.refresh_token) {
    console.warn("⚠️ Novo refresh token gerado — ATUALIZE NO RENDER");
    console.warn(response.data.refresh_token);
  }

  return rdAccessToken;
}

/* ===============================
   DE → PARA DE CONVERSÕES
================================ */

const conversionMap = [
  { match: "ortoped", conversion: "Pós-graduação Orto" },
  { match: "inunodeprimido", conversion: "Pós-graduação Imuno" },
  { match: "imunodeprimidos", conversion: "Pós-graduação Imuno" },
  { match: "infecção hospitalar", conversion: "Pós-graduação ccih" },
  { match: "pediatria", conversion: "Pós-graduação Pediatria" },
  { match: "multi-r", conversion: "Jornada Multi-R" },
  { match: "ccih", conversion: "Pós-graduação ccih" }
];

function resolveConversion(productName = "") {
  const normalized = productName.toLowerCase();
  const found = conversionMap.find(item =>
    normalized.includes(item.match)
  );
  return found ? found.conversion : "Conversão Não Mapeada";
}

function normalizeConversion(name) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-");
}

/* ===============================
   EXTRAÇÃO DE DADOS DA VINDI
================================ */

function extractEmail(payload) {
  return (
    payload?.event?.data?.customer?.email ||
    payload?.event?.data?.bill?.customer?.email ||
    payload?.event?.data?.subscription?.customer?.email ||
    null
  );
}

function extractName(payload) {
  return (
    payload?.event?.data?.customer?.name ||
    payload?.event?.data?.bill?.customer?.name ||
    payload?.event?.data?.subscription?.customer?.name ||
    ""
  );
}

function extractProductName(payload) {
  const billItems = payload?.event?.data?.bill?.bill_items;
  if (billItems && billItems.length > 0) {
    return billItems[0]?.product?.name || "";
  }
  return (
    payload?.event?.data?.subscription?.plan?.name ||
    payload?.event?.data?.charge?.description ||
    ""
  );
}

/* ===============================
   ENVIO DE CONVERSÃO PARA RD
================================ */

async function sendConversion(email, conversionName) {
  const token = await getRdAccessToken();

  const payload = {
    event_type: "CONVERSION",
    event_family: "CDP",
    payload: {
      conversion_identifier: normalizeConversion(conversionName),
      email: email
    }
  };

  console.log("➡️ Enviando conversão para RD:", payload.payload.conversion_identifier);

  await axios.post(RD_CONVERSION_URL, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });
}

/* ===============================
   WEBHOOK VINDI
================================ */

app.post("/webhook/vindi", async (req, res) => {
  try {
    console.log("📩 WEBHOOK DA VINDI RECEBIDO");
    console.log(JSON.stringify(req.body));

    const eventType = req.body?.event?.type;
    console.log("📌 EVENTO RECEBIDO:", eventType);

    const email = extractEmail(req.body);
    const name = extractName(req.body);
    const productName = extractProductName(req.body);

    if (!email) {
      console.warn("⚠️ EMAIL NÃO ENCONTRADO — evento ignorado");
      return res.status(200).send("email não encontrado");
    }

    const baseConversion = resolveConversion(productName);

    if (eventType === "bill_created") {
      await sendConversion(email, `${baseConversion} - pendente`);
    }

    if (eventType === "bill_paid") {
      await sendConversion(email, `${baseConversion} - pago`);
    }

    console.log("✅ Webhook processado com sucesso");
    return res.status(200).send("ok");

  } catch (error) {
    console.error("❌ ERRO WEBHOOK:", error.response?.data || error.message);
    return res.status(200).send("erro tratado");
  }
});

/* ===============================
   START SERVER
================================ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Webhook rodando");
});
