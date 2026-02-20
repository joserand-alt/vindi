const express = require("express");
const axios = require("axios");
const { saveEventAsync } = require("./dbWriter");
const { runProcessor } = require("./eventProcessor");

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

  console.log("Renovando access token da RD...");

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
    console.log("Novo refresh token gerado. Atualize no ambiente (Render, etc):");
    console.log(response.data.refresh_token);
  }

  return rdAccessToken;
}

/* =========================================================
   MAPEAMENTO DE PRODUTOS → CONVERSÃO RD
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

  const normalized = productName.toString().toLowerCase();

  const found = conversionMap.find((item) =>
    normalized.includes(item.match.toLowerCase())
  );

  return found ? found.conversion : null;
}

/* =========================================================
   HELPERS VINDI
========================================================= */

// Vindi manda no formato: req.body.event.data.[subscription|bill]...
function extractVindiEmail(payload) {
  return (
    payload?.event?.data?.subscription?.customer?.email ||
    payload?.event?.data?.bill?.customer?.email ||
    null
  );
}

function extractVindiProductName(payload) {
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
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    if (err.response?.status === 404) {
      await axios.post(
        "https://api.rd.services/platform/contacts",
        { email },
        { headers: { Authorization: `Bearer ${token}` } }
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

  console.log(`Enviando conversão para RD: ${identifier}`);

  await axios.post(
    "https://api.rd.services/platform/events",
    {
      event_type: "CONVERSION",
      event_family: "CDP",
      payload: { conversion_identifier: identifier, email },
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

/* =========================================================
   WEBHOOK VINDI
========================================================= */

app.post("/webhook/vindi", async (req, res) => {
  try {
    const eventType = req.body?.event?.type;
    console.log("Evento Vindi recebido:", eventType);

    const email = extractVindiEmail(req.body);
    if (!email) {
      console.log("Email não encontrado no payload da Vindi, evento ignorado");
      return res.sendStatus(200);
    }

    const productName = extractVindiProductName(req.body);
    console.log("Produto Vindi:", productName);

    const baseConversion = resolveConversion(productName);
    if (!baseConversion) {
      console.log("Produto Vindi sem mapeamento, evento ignorado");
      return res.sendStatus(200);
    }

    await createOrUpdateContact(email);

    let status = null;
    let conversionName = null;

    if (eventType === "subscription_created" || eventType === "bill_created") {
      status = "pendente";
      conversionName = `${baseConversion} - pendente`;
      await sendConversion(email, conversionName);
    }

    if (eventType === "bill_paid") {
      status = "pago";
      conversionName = `${baseConversion} - pago`;
      await sendConversion(email, conversionName);
    }

    // salva evento cru no banco
    saveEventAsync({
      source: "vindi",
      eventType,
      email,
      productName,
      conversion: conversionName,
      status,
      payload: req.body,
    }).catch((err) =>
      console.error("Erro ao salvar evento Vindi no banco:", err.message)
    );

    res.sendStatus(200);
  } catch (err) {
    console.error("Erro webhook Vindi:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

/* =========================================================
   HELPERS KIWIFY
   Baseados no payload real que você enviou
========================================================= */

/*
Exemplo real que você mandou (resumido):

{
  "order_id": "...",
  "order_status": "paid",
  "webhook_event_type": "order_approved",
  "Product": {
    "product_id": "...",
    "product_name": "Example product"
  },
  "Customer": {
    "full_name": "John Doe",
    "email": "johndoe@example.com",
    ...
  },
  "event_tickets": [
    { "name": "John Doe", "email": "johndoe@example.com", ... },
    { "name": "Jane Doe", "email": "janedoe@example.com", ... }
  ],
  ...
}
*/

function extractKiwifyEmail(payload) {
  if (payload?.Customer?.email) {
    return payload.Customer.email;
  }

  if (Array.isArray(payload?.event_tickets) && payload.event_tickets.length > 0) {
    return payload.event_tickets[0].email || null;
  }

  return null;
}

function extractKiwifyName(payload) {
  if (payload?.Customer?.full_name) {
    return payload.Customer.full_name;
  }

  if (Array.isArray(payload?.event_tickets) && payload.event_tickets.length > 0) {
    return payload.event_tickets[0].name || null;
  }

  return null;
}

function extractKiwifyProductName(payload) {
  if (payload?.Product?.product_name) {
    return payload.Product.product_name;
  }

  if (payload?.event_batch?.name) {
    return payload.event_batch.name;
  }

  return null;
}

function extractKiwifyTrigger(payload) {
  // ex.: "order_approved"
  return payload?.webhook_event_type || null;
}

function extractKiwifyOrderStatus(payload) {
  // ex.: "paid"
  return payload?.order_status || null;
}

/* =========================================================
   WEBHOOK KIWIFY
========================================================= */

app.post("/webhook/kiwify", async (req, res) => {
  try {
    const payload = req.body;

    console.log("Evento Kiwify recebido:", payload?.webhook_event_type);

    const email = extractKiwifyEmail(payload);
    const name = extractKiwifyName(payload);
    const productName = extractKiwifyProductName(payload);
    const trigger = extractKiwifyTrigger(payload);
    const orderStatus = extractKiwifyOrderStatus(payload);

    if (!email) {
      console.log("Email não encontrado no payload da Kiwify, evento ignorado");
      return res.sendStatus(200);
    }

    console.log("Cliente Kiwify:", email, "-", name);
    console.log("Produto Kiwify:", productName);
    console.log("Trigger Kiwify:", trigger);
    console.log("Status do pedido Kiwify:", orderStatus);

    const baseConversion = resolveConversion(productName);
    if (!baseConversion) {
      console.log("Produto Kiwify sem mapeamento, evento ignorado");
      return res.sendStatus(200);
    }

    await createOrUpdateContact(email);

    let status = null;
    let conversionName = null;

    // pendente / intenção
    if (trigger === "order_created" || orderStatus === "pending") {
      status = "pendente";
      conversionName = `${baseConversion} - pendente`;
      await sendConversion(email, conversionName);
    }

    // pago / aprovado
    if (trigger === "order_approved" || orderStatus === "paid") {
      status = "pago";
      conversionName = `${baseConversion} - pago`;
      await sendConversion(email, conversionName);
    }

    // reembolsado (se você quiser marcar na RD)
    if (trigger === "order_refunded" || orderStatus === "refunded") {
      status = "reembolsado";
      conversionName = `${baseConversion} - reembolsado`;
      await sendConversion(email, conversionName);
    }

    // salva evento cru no banco
    saveEventAsync({
      source: "kiwify",
      trigger,
      orderStatus,
      email,
      name,
      productName,
      status,
      conversion: conversionName,
      payload,
    }).catch((err) => {
      console.error("Erro ao salvar evento Kiwify no banco:", err.message);
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("Erro webhook Kiwify:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

/* =========================================================
   SERVER + PROCESSOR LOOP
========================================================= */

let processorRunning = false;

function startEventProcessorLoop() {
  setInterval(async () => {
    if (processorRunning) return;
    processorRunning = true;

    try {
      await runProcessor();
    } catch (err) {
      console.error("Erro no processador de eventos:", err.message);
    } finally {
      processorRunning = false;
    }
  }, 60 * 1000);
}

app.get("/", (_, res) => {
  res.send("Webhook Vindi e Kiwify → RD rodando");
});

app.listen(PORT, () => {
  console.log("Webhook rodando na porta", PORT);
  startEventProcessorLoop();
});

