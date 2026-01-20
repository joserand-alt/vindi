const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ======================================================
// TABELA DE REGRAS – TERMOS x CONVERSÃO
// ======================================================

const CONVERSION_RULES = [
  {
    terms: ["ortoped", "ortopedicas"],
    conversion: "pos-graduacao-orto"
  },
  {
    terms: ["inunodeprimido", "imunodeprimido", "imunodeprimidos"],
    conversion: "pos-graduacao-imuno"
  },
  {
    terms: ["infeccao hospitalar", "ccih"],
    conversion: "pos-graduacao-ccih"
  },
  {
    terms: ["pediatria", "pediatrico", "pediatrica"],
    conversion: "pos-graduacao-pediatria"
  },
  {
    terms: ["multi-r", "multir", "multi r"],
    conversion: "jornada-multi-r"
  }
];

// ======================================================
// OAUTH RD – ACCESS TOKEN VIA REFRESH TOKEN
// ======================================================

async function getAccessToken() {
  const params = new URLSearchParams();
  params.append("client_id", process.env.RD_CLIENT_ID);
  params.append("client_secret", process.env.RD_CLIENT_SECRET);
  params.append("refresh_token", process.env.RD_REFRESH_TOKEN);
  params.append("grant_type", "refresh_token");

  const response = await axios.post(
    "https://api.rd.services/auth/token",
    params.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  return response.data.access_token;
}

// ======================================================
// NORMALIZA STRING (TAG / TEXTO)
// ======================================================

function normalize(value) {
  if (!value) return null;

  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-");
}

// ======================================================
// RESOLVE CONVERSÃO PELO TEXTO (CONTENÇÃO DE TERMOS)
// ======================================================

function resolveConversionByTerms(text) {
  if (!text) return null;

  const normalizedText = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  for (const rule of CONVERSION_RULES) {
    for (const term of rule.terms) {
      if (normalizedText.includes(term)) {
        return rule.conversion;
      }
    }
  }

  return null;
}

// ======================================================
// GARANTE CONTATO NO RD
// ======================================================

async function ensureContact({ email, name, accessToken }) {
  await axios.patch(
    `https://api.rd.services/platform/contacts/email:${email}`,
    { name },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ======================================================
// ADICIONA TAGS AO CONTATO
// ======================================================

async function addTags({ email, tags, accessToken }) {
  await axios.post(
    `https://api.rd.services/platform/contacts/email:${email}/tag`,
    { tags },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ======================================================
// REGISTRA CONVERSÃO NO RD
// ======================================================

async function registerConversion({ email, eventIdentifier, accessToken }) {
  try {
    await axios.post(
      "https://api.rd.services/platform/events",
      {
        event_type: "CONVERSION",
        event_family: "CDP",
        event_identifier: eventIdentifier,
        payload: { email }
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("CONVERSÃO REGISTRADA:", eventIdentifier);
  } catch (error) {
    console.error(
      "ERRO AO REGISTRAR CONVERSÃO:",
      error.response?.data || error.message
    );
  }
}

// ======================================================
// WEBHOOK VINDI
// ======================================================

app.post("/webhook/vindi", async (req, res) => {
  console.log("WEBHOOK DA VINDI CHEGOU");
  console.log(JSON.stringify(req.body));

  try {
    const payload = req.body;
    const eventType = payload?.event?.type;

    console.log("EVENTO:", eventType);

    const accessToken = await getAccessToken();

    // ==================================================
    // SUBSCRIPTION CREATED → CONVERSÃO PENDENTE
    // ==================================================
    if (eventType === "subscription_created") {
      const subscription = payload?.event?.data?.subscription;
      const customer = subscription?.customer;

      const email = customer?.email;
      const name = customer?.name || "";

      if (!email) return res.status(200).send("email ausente");

      const rawText =
        subscription?.plan?.name ||
        subscription?.product?.name ||
        "";

      const conversionBase = resolveConversionByTerms(rawText);
      const productTag = normalize(conversionBase);

      await ensureContact({ email, name, accessToken });

      const tags = ["assinatura-criada"];
      if (productTag) tags.push(productTag);

      await addTags({ email, tags, accessToken });

      if (conversionBase) {
        await registerConversion({
          email,
          eventIdentifier: `${conversionBase}-pendente`,
          accessToken
        });
      }

      console.log("ASSINATURA PROCESSADA");
    }

    // ==================================================
    // BILL PAID → CONVERSÃO PAGA
    // ==================================================
    if (eventType === "bill_paid") {
      const bill = payload?.event?.data?.bill;
      const customer = bill?.customer;

      const email = customer?.email;
      const name = customer?.name || "";

      if (!email) return res.status(200).send("email ausente");

      const rawText =
        bill?.bill_items?.[0]?.product?.name ||
        "";

      const conversionBase = resolveConversionByTerms(rawText);
      const productTag = normalize(conversionBase);

      await ensureContact({ email, name, accessToken });

      const tags = ["cobranca-paga"];
      if (productTag) tags.push(productTag);

      await addTags({ email, tags, accessToken });

      if (conversionBase) {
        await registerConversion({
          email,
          eventIdentifier: `${conversionBase}-pago`,
          accessToken
        });
      }

      console.log("PAGAMENTO PROCESSADO");
    }

    return res.status(200).send("ok");
  } catch (error) {
    console.error("ERRO NO WEBHOOK");

    if (error.response) {
      console.error("STATUS:", error.response.status);
      console.error("DATA:", JSON.stringify(error.response.data));
    } else {
      console.error(error.message);
    }

    return res.status(200).send("erro tratado");
  }
});

// ======================================================
// HEALTHCHECK
// ======================================================

app.get("/", (req, res) => {
  res.status(200).send("online");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Webhook rodando");
});


