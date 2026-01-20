const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

/* ===============================
   CONFIGURAÇÕES
================================ */

const RD_EVENTS_URL = "https://api.rd.services/platform/events";

/* ===============================
   REGRAS DE CONVERSÃO (DE-PARA)
================================ */

const CONVERSION_RULES = [
  { terms: ["ortoped"], base: "pos-graduacao-orto" },
  { terms: ["inunodeprimido", "imunodeprimido", "imunodeprimidos"], base: "pos-graduacao-imuno" },
  { terms: ["infeccao hospitalar", "ccih"], base: "pos-graduacao-ccih" },
  { terms: ["pediatria"], base: "pos-graduacao-pediatria" },
  { terms: ["multi-r", "multir", "multi r"], base: "jornada-multi-r" }
];

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function resolveConversion(text) {
  if (!text) return null;

  const normalized = normalize(text);

  for (const rule of CONVERSION_RULES) {
    for (const term of rule.terms) {
      if (normalized.includes(term)) {
        return rule.base;
      }
    }
  }
  return null;
}

/* ===============================
   ENVIO DE CONVERSÃO PARA O RD
================================ */

async function sendConversionToRD(email, conversionIdentifier) {
  console.log("ENVIANDO CONVERSÃO PARA RD:", conversionIdentifier);

  const response = await axios.post(
    RD_EVENTS_URL,
    {
      event_type: "CONVERSION",
      event_family: "CDP",
      timestamp: new Date().toISOString(),
      payload: {
        conversion_identifier: conversionIdentifier,
        email: email
      }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.RD_API_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );

  console.log("RD STATUS:", response.status);
}

/* ===============================
   WEBHOOK VINDI
================================ */

app.post("/webhook/vindi", async (req, res) => {
  try {
    const eventType = req.body?.event?.type;
    const data = req.body?.event?.data;

    console.log("EVENTO RECEBIDO:", eventType);

    const email = extractEmail(data);

if (!email) {
  console.log("EMAIL NÃO ENCONTRADO NO PAYLOAD:", JSON.stringify(data));
  return res.status(200).send("Sem email");
}

console.log("EMAIL ENCONTRADO:", email);


    /* ===============================
       BILL CREATED = PENDENTE
    ================================ */

    if (eventType === "bill_created") {
      const productName =
        data.bill?.bill_items?.[0]?.product?.name || "";

      console.log("PRODUTO:", productName);

      const conversionBase = resolveConversion(productName);
      console.log("BASE CONVERSÃO:", conversionBase);

      if (conversionBase) {
        await sendConversionToRD(
          email,
          `${conversionBase}-pendente`
        );
      }
    }

    /* ===============================
       BILL PAID = PAGO
    ================================ */

    if (eventType === "bill_paid") {
      const productName =
        data.bill?.bill_items?.[0]?.product?.name || "";

      console.log("PRODUTO:", productName);

      const conversionBase = resolveConversion(productName);
      console.log("BASE CONVERSÃO:", conversionBase);

      if (conversionBase) {
        await sendConversionToRD(
          email,
          `${conversionBase}-pago`
        );
      }
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("ERRO WEBHOOK:", error.response?.data || error.message);
    return res.status(200).send("Erro tratado");
  }
});

/* ===============================
   START
================================ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Webhook rodando");
});

