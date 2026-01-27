import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

/* =========================
   CONFIGURAÇÕES
========================= */

const {
  RD_CLIENT_ID,
  RD_CLIENT_SECRET,
  RD_REFRESH_TOKEN,
} = process.env;

let rdAccessToken = null;

/* =========================
   UTILIDADES
========================= */

function normalizeConversionIdentifier(text) {
  return text
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================
   TABELA TERMOS → CONVERSÃO
========================= */

const conversionMap = [
  { term: "ortoped", conversion: "pos-graduacao-orto" },
  { term: "imunodeprim", conversion: "pos-graduacao-imuno" },
  { term: "imunossuprim", conversion: "pos-graduacao-imuno" },
  { term: "infeccao hospitalar", conversion: "pos-graduacao-ccih" },
  { term: "ccih", conversion: "pos-graduacao-ccih" },
  { term: "pediatria", conversion: "pos-graduacao-pediatria" },
  { term: "multi-r", conversion: "jornada-multi-r" },
];

function resolveConversion(productName) {
  if (!productName) return null;
  const name = productName.toLowerCase();
  for (const item of conversionMap) {
    if (name.includes(item.term)) {
      return item.conversion;
    }
  }
  return null;
}

/* =========================
   RD TOKEN
========================= */

async function refreshRDToken() {
  console.log("🔄 Renovando access token da RD...");

  const { data } = await axios.post(
    "https://api.rd.services/auth/token",
    {
      client_id: RD_CLIENT_ID,
      client_secret: RD_CLIENT_SECRET,
      refresh_token: RD_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }
  );

  rdAccessToken = data.access_token;

  if (data.refresh_token) {
    console.log("⚠️ Novo refresh token gerado — ATUALIZE NO RENDER");
    console.log(data.refresh_token);
  }
}

/* =========================
   RD CONTATO
========================= */

async function upsertContact(email, name) {
  await axios.patch(
    `https://api.rd.services/platform/contacts/email:${encodeURIComponent(email)}`,
    { name },
    {
      headers: { Authorization: `Bearer ${rdAccessToken}` },
    }
  );
}

/* =========================
   RD CONVERSÃO (COM RETRY)
========================= */

async function sendConversion(email, conversion) {
  const payload = {
    event_type: conversion,
    event_family: "CDP",
    payload: { email },
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`➡️ Enviando conversão (${attempt}/3): ${conversion}`);

      await axios.post(
        "https://api.rd.services/platform/events",
        payload,
        {
          headers: {
            Authorization: `Bearer ${rdAccessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      console.log("✅ Conversão enviada com sucesso");
      return;
    } catch (err) {
      console.error(
        `❌ Falha ao enviar conversão (tentativa ${attempt})`,
        err.response?.data || err.message
      );
      await sleep(1000);
    }
  }

  throw new Error("Falha definitiva ao enviar conversão");
}

/* =========================
   EXTRATORES VINDI
========================= */

function extractEmail(payload) {
  return (
    payload?.data?.customer?.email ||
    payload?.data?.subscription?.customer?.email ||
    payload?.data?.bill?.customer?.email ||
    null
  );
}

function extractProduct(payload) {
  return (
    payload?.data?.subscription?.plan?.name ||
    payload?.data?.bill?.bill_items?.[0]?.product?.name ||
    null
  );
}

/* =========================
   WEBHOOK
========================= */

app.post("/webhook/vindi", async (req, res) => {
  try {
    console.log("📩 WEBHOOK DA VINDI RECEBIDO");
    console.log(JSON.stringify(req.body));

    const eventType = req.body?.event?.type;
    console.log("📌 EVENTO RECEBIDO:", eventType);

    if (!rdAccessToken) {
      await refreshRDToken();
    }

    const email = extractEmail(req.body);
    const product = extractProduct(req.body);

    if (!email) {
      console.log("⚠️ Email não encontrado, evento ignorado");
      return res.sendStatus(200);
    }

    const baseConversion = resolveConversion(product);
    if (!baseConversion) {
      console.log("⚠️ Produto sem conversão mapeada:", product);
      return res.sendStatus(200);
    }

    const status =
      eventType === "bill_paid" ? "pago" : "pendente";

    const conversion = normalizeConversionIdentifier(
      `${baseConversion}-${status}`
    );

    await upsertContact(email);
    await sendConversion(email, conversion);

    console.log("✅ Webhook processado com sucesso");
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ ERRO WEBHOOK FINAL:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

/* =========================
   START
========================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("🚀 Webhook rodando na porta", PORT);
});
