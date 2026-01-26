const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

/* ===============================
   CONFIG RD STATION
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
   DE → PARA DE PRODUTOS
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
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* ===============================
   EXTRAÇÃO VINDI
================================ */

function extractEmail(payload) {
  return (
    payload?.event?.data?.customer?.email ||
    payload?.event?.data?.bill?.customer?.email ||
    payload?.event?.data?.subscription?.customer?.email ||
    null
  );
}

function extractProductName(payload) {
  const billItems = payload?.event?.data?.bill?.bill_items;
  if (billItems?.length) {
    return billItems[0]?.product?.name || "";
  }
  return (
    payload?.event?.data?.subscription?.plan?.name ||
    payload?.event?.data?.charge?.description ||
    ""
  );
}

/* ===============================
   ENVIO COM RETRY PARA RD
================================ */

async function sendConversionWithRetry(email, conversionName, attempts = 3) {
  const token = await getRdAccessToken();

  const payload = {
    event_type: "CONVERSION",
    event_family: "CDP",
    payload: {
      conversion_identifier: normalizeConversion(conversionName),
      email
    }
  };

  for (let i = 1; i <= attempts; i++) {
    try {
      console.log(`➡️ Enviando conversão (${i}/${attempts}):`, payload.payload.conversion_identifier);

      await axios.post(RD_CONVERSION_URL, payload, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      });

      console.log("✅ Conversão enviada com sucesso");
      return;

    } catch (err) {
      console.error(`❌ Falha ao enviar conversão (tentativa ${i})`,
        err.response?.data || err.message
      );

      if (i === attempts) {
        throw err;
      }

      await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
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
    const productName = extractProductName(req.body);

    if (!email) {
      console.warn("⚠️ EMAIL NÃO ENCONTRADO — evento ignorado");
      return res.status(200).send("email não encontrado");
    }

    const baseConversion = resolveConversion(productName);

    if (eventType === "bill_created") {
      await sendConversionWithRetry(email, `${baseConversion} pendente`);
    }

    if (eventType === "bill_paid") {
      await sendConversionWithRetry(email, `${baseConversion} pago`);
    }

    console.log("✅ Webhook processado com sucesso");
    res.status(200).send("ok");

  } catch (error) {
    console.error("❌ ERRO WEBHOOK FINAL:", error.response?.data || error.message);
    res.status(200).send("erro tratado");
  }
});

/* ===============================
   START
================================ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Webhook rodando");
});
