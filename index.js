const express = require("express");
const axios = require("axios");
const { saveEventAsync } = require("./services/dbWriter");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

/* =========================================================
   OAUTH RD STATION – REFRESH AUTOMÁTICO
========================================================= */

let rdAccessToken = null;
let rdTokenExpiresAt = null;

async function getRdAccessToken() {
  if (rdAccessToken && rdTokenExpiresAt > Date.now()) {
    return rdAccessToken;
  }

  console.log("🔄 Renovando access token da RD");

  const response = await axios.post(
    "https://api.rd.services/auth/token",
    {
      client_id: process.env.RD_CLIENT_ID,
      client_secret: process.env.RD_CLIENT_SECRET,
      refresh_token: process.env.RD_REFRESH_TOKEN,
      grant_type: "refresh_token"
    }
  );

  rdAccessToken = response.data.access_token;
  rdTokenExpiresAt = Date.now() + (response.data.expires_in - 60) * 1000;

  if (response.data.refresh_token) {
    process.env.RD_REFRESH_TOKEN = response.data.refresh_token;
    console.log("🔁 Novo refresh token gerado – atualizar no Render");
  }

  return rdAccessToken;
}

/* =========================================================
   TABELA DE CONVERSÕES (CONTÉM TERMO)
========================================================= */

const conversionMap = [
  { match: "ortoped", conversion: "Pós-graduação Orto" },
  { match: "inunodeprimido", conversion: "Pós-graduação Imuno" },
  { match: "imunodeprimido", conversion: "Pós-graduação Imuno" },
  { match: "infecção hospitalar", conversion: "Pós-graduação ccih" },
  { match: "ccih", conversion: "Pós-graduação ccih" },
  { match: "pediatriatras", conversion: "Pós-graduação Pediatria - pediatras" },
  { match: "pediatria", conversion: "Pós-graduação Pediatria - Infecto" },
  { match: "ped", conversion: "Pós-graduação Pediatria - Infecto" },
  { match: "multi-r", conversion: "Jornada Multi-R" }
];

function resolveConversion(productName) {
  if (!productName) return null;

  const normalized = productName.toLowerCase();

  const found = conversionMap.find(item =>
    normalized.includes(item.match)
  );

  return found ? found.conversion : null;
}

function normalizeConversion(name) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-");
}

/* =========================================================
   HELPERS DE EXTRAÇÃO (VINDI)
========================================================= */

function extractEmail(payload) {
  return (
    payload?.event?.data?.customer?.email ||
    payload?.event?.data?.bill?.customer?.email ||
    payload?.event?.data?.subscription?.customer?.email ||
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
   ENVIO DE CONVERSÃO PARA RD
========================================================= */

async function sendConversion(email, conversionName) {
  const token = await getRdAccessToken();

  console.log("🚀 ENVIANDO CONVERSÃO:", conversionName);

  await axios.post(
    "https://api.rd.services/platform/events",
    {
      event_type: "CONVERSION",
      event_family: "CDP",
      timestamp: new Date().toISOString(),
      payload: {
        conversion_identifier: normalizeConversion(conversionName),
        email
      }
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    }
  );
}

/* =========================================================
   WEBHOOK VINDI
========================================================= */

app.post("/webhook/vindi", async (req, res) => {
  try {
    console.log("===== PAYLOAD VINDI =====");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("========================");

    const eventType = req.body?.event?.type;
    console.log("📩 EVENTO:", eventType);

    const email = extractEmail(req.body);
    if (!email) {
      console.log("⚠️ EMAIL NÃO ENCONTRADO");
      return res.sendStatus(200);
    }

    const productName = extractProductName(req.body);
    const baseConversion = resolveConversion(productName);

    console.log("📦 PRODUTO:", productName);
    console.log("🎯 CONVERSÃO BASE:", baseConversion);

    if (!baseConversion) {
      console.log("⚠️ Produto sem mapeamento");
      return res.sendStatus(200);
    }

    /* ===============================
       CONVERSÕES RD
    ================================ */

    if (eventType === "bill_created") {
      await sendConversion(email, `${baseConversion} - pendente`);
    }

    if (eventType === "bill_paid") {
      await sendConversion(email, `${baseConversion} - pago`);
    }

    /* ===============================
       REGISTRO NO BANCO (SIDE EFFECT)
    ================================ */

    saveEventAsync({
      eventType,
      email,
      name:
        req.body?.event?.data?.customer?.name ||
        req.body?.event?.data?.bill?.customer?.name ||
        req.body?.event?.data?.subscription?.customer?.name ||
        null,

      vindiCustomerId:
        req.body?.event?.data?.customer?.id ||
        req.body?.event?.data?.bill?.customer?.id ||
        req.body?.event?.data?.subscription?.customer?.id ||
        null,

      vindiSubscriptionId:
        req.body?.event?.data?.subscription?.id || null,

      vindiBillId:
        req.body?.event?.data?.bill?.id || null,

      productName,

      planName:
        req.body?.event?.data?.subscription?.plan?.name || null,

      amount:
        req.body?.event?.data?.bill?.amount || null,

      status:
        req.body?.event?.data?.bill?.status ||
        req.body?.event?.data?.subscription?.status ||
        null,

      dueAt:
        req.body?.event?.data?.bill?.due_at || null
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ ERRO WEBHOOK:", err.response?.data || err.message);
    return res.sendStatus(200);
  }
});

/* =========================================================
   HEALTHCHECK
========================================================= */

app.get("/", (_, res) => {
  res.send("Webhook Vindi → RD + DB rodando");
});

app.listen(PORT, () => {
  console.log("🚀 Servidor rodando na porta", PORT);
});
