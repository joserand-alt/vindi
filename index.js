const express = require("express");
const axios = require("axios");
const { saveEventAsync } = require("./dbWriter");
const { runProcessor } = require("./eventProcessor");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

/* =========================================================
   RD STATION OAuth
========================================================= */

let rdAccessToken = null;
let rdTokenExpiresAt = 0;

async function getRdAccessToken() {
  if (rdAccessToken && rdTokenExpiresAt > Date.now()) {
    return rdAccessToken;
  }

  console.log("Renovando access token da RD");

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
    console.log("Novo refresh token gerado, atualize no ambiente");
    console.log(response.data.refresh_token);
  }

  return rdAccessToken;
}

/* =========================================================
   MAPEAMENTO DE PRODUTOS PARA CONVERSAO RD
========================================================= */

const conversionMap = [
  { match: "ortopéd", conversion: "Pós graduação Orto" },
  { match: "inunodeprimido", conversion: "Pós graduação Imuno" },
  { match: "imunodeprimido", conversion: "Pós graduação Imuno" },
  { match: "infecção hospitalar", conversion: "Pós graduação ccih" },
  { match: "ccih", conversion: "Pós graduação ccih" },
  { match: "pediatria", conversion: "Pós graduação Pediatria" },
  { match: "multi r", conversion: "Jornada Multi R" },
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
   RD CONTATO E CONVERSAO
========================================================= */

async function createOrUpdateContact(email, name) {
  const token = await getRdAccessToken();

  try {
    const payload = {};
    if (name) payload.name = name;

    await axios.patch(
      `https://api.rd.services/platform/contacts/email:${email}`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    if (err.response?.status === 404) {
      await axios.post(
        "https://api.rd.services/platform/contacts",
        { email, name },
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } else {
      throw err;
    }
  }
}

async function sendConversion(email, conversionName) {
  const token = await getRdAccessToken();

  const identifier = conversionName
    .toLowerCase()
    .replace(/\s+/g, "-")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  console.log(`Enviando conversao para RD ${identifier}`);

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
   HELPERS VINDI
========================================================= */

function extractVindiEmail(payload) {
  return (
    payload?.event?.data?.subscription?.customer?.email ||
    payload?.event?.data?.bill?.customer?.email ||
    payload?.bill?.customer?.email ||
    payload?.customer?.email ||
    null
  );
}

function extractVindiName(payload) {
  return (
    payload?.event?.data?.subscription?.customer?.name ||
    payload?.event?.data?.bill?.customer?.name ||
    payload?.bill?.customer?.name ||
    payload?.customer?.name ||
    null
  );
}

function extractVindiProductName(payload) {
  if (payload?.event?.data?.bill?.bill_items?.[0]?.product?.name) {
    return payload.event.data.bill.bill_items[0].product.name;
  }

  if (payload?.event?.data?.subscription?.plan?.name) {
    return payload.event.data.subscription.plan.name;
  }

  if (Array.isArray(payload?.bill?.bill_items) && payload.bill.bill_items.length > 0) {
    return payload.bill.bill_items[0].product?.name || null;
  }

  return null;
}

function extractVindiEventType(payload) {
  return payload?.event?.type || payload?.type || null;
}

/* =========================================================
   HELPERS KIWIFY
========================================================= */

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
  return payload?.webhook_event_type || null;
}

function extractKiwifyOrderStatus(payload) {
  return payload?.order_status || null;
}

/* =========================================================
   PROCESSADORES ESPECIFICOS
========================================================= */

async function processVindiEvent(payload) {
  const eventType = extractVindiEventType(payload);
  console.log("Evento identificado como Vindi", eventType);

  const email = extractVindiEmail(payload);
  const name = extractVindiName(payload);
  const productName = extractVindiProductName(payload);

  if (!email) {
    console.log("Email nao encontrado no payload Vindi dentro do processador");
    return;
  }

  console.log("Cliente Vindi", email, name);
  console.log("Produto Vindi", productName);

  let baseConversion = resolveConversion(productName);
  if (!baseConversion) {
    baseConversion = productName || "Produto Vindi";
    console.log("Produto Vindi sem mapeamento, usando nome do produto como conversao", baseConversion);
  }

  await createOrUpdateContact(email, name);

  let status = null;
  let conversionName = null;

  if (eventType === "subscription_created" || eventType === "bill_created") {
    status = "pendente";
    conversionName = `${baseConversion} pendente`;
    await sendConversion(email, conversionName);
  }

  if (eventType === "bill_paid" || eventType === "subscription_activated") {
    status = "pago";
    conversionName = `${baseConversion} pago`;
    await sendConversion(email, conversionName);
  }

  if (
    eventType === "bill_canceled" ||
    eventType === "bill_refunded" ||
    eventType === "subscription_canceled"
  ) {
    status = "problema";
    conversionName = `${baseConversion} problema`;
    await sendConversion(email, conversionName);
  }

  await saveEventAsync({
    source: "vindi",
    eventType,              // aqui preenche eventType para o banco
    email,
    name,
    productName,
    status,
    conversion: conversionName,
    payload,
  }).catch((err) => {
    console.error("Erro ao salvar evento Vindi no banco", err.message);
  });
}

async function processKiwifyEvent(payload) {
  const trigger = extractKiwifyTrigger(payload);
  const orderStatus = extractKiwifyOrderStatus(payload);
  console.log("Evento identificado como Kiwify", trigger, orderStatus);

  const email = extractKiwifyEmail(payload);
  const name = extractKiwifyName(payload);
  const productName = extractKiwifyProductName(payload);

  if (!email) {
    console.log("Email nao encontrado no payload Kiwify dentro do processador");
    return;
  }

  console.log("Cliente Kiwify", email, name);
  console.log("Produto Kiwify", productName);

  let baseConversion = resolveConversion(productName);
  if (!baseConversion) {
    baseConversion = productName || "Produto Kiwify";
    console.log("Produto Kiwify sem mapeamento, usando nome do produto como conversao", baseConversion);
  }

  await createOrUpdateContact(email, name);

  let status = null;
  let conversionName = null;

  if (trigger === "order_created" || orderStatus === "pending") {
    status = "pendente";
    conversionName = `${baseConversion} pendente`;
    await sendConversion(email, conversionName);
  }

  if (trigger === "order_approved" || orderStatus === "paid") {
    status = "pago";
    conversionName = `${baseConversion} pago`;
    await sendConversion(email, conversionName);
  }

  if (trigger === "order_refunded" || orderStatus === "refunded") {
    status = "reembolsado";
    conversionName = `${baseConversion} reembolsado`;
    await sendConversion(email, conversionName);
  }

  await saveEventAsync({
    source: "kiwify",
    eventType: trigger || orderStatus || "kiwify_event",  // linha chave para corrigir o erro
    trigger,
    orderStatus,
    email,
    name,
    productName,
    status,
    conversion: conversionName,
    payload,
  }).catch((err) => {
    console.error("Erro ao salvar evento Kiwify no banco", err.message);
  });
}

/* =========================================================
   ENDPOINT UNICO VINDI PRIMEIRO KIWIFY DEPOIS
========================================================= */

app.post("/webhook/vindi", async (req, res) => {
  try {
    const payload = req.body;

    console.log("Webhook recebido", JSON.stringify(payload));

    const vindiEmail = extractVindiEmail(payload);

    if (vindiEmail) {
      await processVindiEvent(payload);
      return res.sendStatus(200);
    }

    const kiwifyEmail = extractKiwifyEmail(payload);

    if (kiwifyEmail) {
      await processKiwifyEvent(payload);
      return res.sendStatus(200);
    }

    console.log("Email nao encontrado nem como Vindi nem como Kiwify, evento ignorado");
    res.sendStatus(200);
  } catch (err) {
    console.error("Erro no endpoint unificado", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

/* =========================================================
   SERVER E LOOP DO PROCESSADOR
========================================================= */

let processorRunning = false;

function startEventProcessorLoop() {
  setInterval(async () => {
    if (processorRunning) return;
    processorRunning = true;

    try {
      await runProcessor();
    } catch (err) {
      console.error("Erro no processador de eventos", err.message);
    } finally {
      processorRunning = false;
    }
  }, 60 * 1000);
}

app.get("/", (_, res) => {
  res.send("Webhook unificado Vindi e Kiwify para RD rodando");
});

app.listen(PORT, () => {
  console.log("Webhook rodando na porta", PORT);
  startEventProcessorLoop();
});

