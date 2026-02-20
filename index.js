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

const RD_CLIENT_ID = process.env.RD_CLIENT_ID;
const RD_CLIENT_SECRET = process.env.RD_CLIENT_SECRET;
const RD_REFRESH_TOKEN = process.env.RD_REFRESH_TOKEN;

async function getRdToken() {
  const now = Date.now();

  if (rdAccessToken && now < rdTokenExpiresAt) {
    return rdAccessToken;
  }

  const resp = await axios.post("https://api.rd.services/auth/token", {
    client_id: RD_CLIENT_ID,
    client_secret: RD_CLIENT_SECRET,
    refresh_token: RD_REFRESH_TOKEN,
  });

  rdAccessToken = resp.data.access_token;
  const expiresIn = resp.data.expires_in || 900;
  rdTokenExpiresAt = now + expiresIn * 1000;

  return rdAccessToken;
}

/* =========================================================
   RD STATION Funcoes de contato e conversao
========================================================= */

async function createOrUpdateContact(email, name) {
  const token = await getRdToken();

  const payload = {
    event_type: "CONTACT_UPSERT",
    event_family: "CDP",
    payload: {
      email,
    },
  };

  if (name) {
    payload.payload.name = name;
  }

  await axios.post(
    "https://api.rd.services/platform/events",
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

async function sendConversion(email, identifier) {
  const token = await getRdToken();

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
   Mapa de conversao por produto Vindi e Kiwify
========================================================= */

const conversionMap = [
  { match: "ortoped", conversion: "Pos graduacao Ortopedia" },
  { match: "inunodeprimido", conversion: "Pos graduacao Imuno" },
  { match: "imunodeprimido", conversion: "Pos graduacao Imuno" },
  { match: "infeccao hospitalar", conversion: "Pos graduacao CCIH" },
  { match: "ccih", conversion: "Pos graduacao CCIH" },
  { match: "pediatria", conversion: "Pos graduacao Pediatria" },
  { match: "multi r", conversion: "Jornada Multi R" },
];

function resolveConversion(productName) {
  if (!productName) return null;

  const normalized = productName.toString().toLowerCase();

  const found = conversionMap.find((item) =>
    normalized.includes(item.match)
  );

  return found ? found.conversion : null;
}

/* =========================================================
   HELPERS VINDI
========================================================= */

/*
  Ajuste estes helpers conforme o payload real da Vindi.
  A ideia aqui e apenas unificar em email, nome do cliente e nome do plano ou produto.
*/

function extractVindiEmail(payload) {
  return (
    payload?.bill?.customer?.email ||
    payload?.customer?.email ||
    null
  );
}

function extractVindiCustomerName(payload) {
  return (
    payload?.bill?.customer?.name ||
    payload?.customer?.name ||
    null
  );
}

function extractVindiProductName(payload) {
  if (payload?.bill?.product) {
    return payload.bill.product.name;
  }

  if (Array.isArray(payload?.bill?.items) && payload.bill.items.length > 0) {
    return payload.bill.items[0].product?.name || null;
  }

  return null;
}

function extractVindiEventType(payload) {
  return payload?.event || payload?.type || null;
}

/* =========================================================
   WEBHOOK VINDI
========================================================= */

app.post("/webhook/vindi", async (req, res) => {
  try {
    const payload = req.body;

    console.log("Evento Vindi recebido", JSON.stringify(payload));

    const email = extractVindiEmail(payload);
    const name = extractVindiCustomerName(payload);
    const productName = extractVindiProductName(payload);
    const eventType = extractVindiEventType(payload);

    if (!email) {
      console.log("Email nao encontrado no payload da Vindi, ignorando");
      return res.sendStatus(200);
    }

    const baseConversion = resolveConversion(productName);

    if (!baseConversion) {
      console.log("Produto Vindi sem mapeamento de conversao, ignorando");
      return res.sendStatus(200);
    }

    await createOrUpdateContact(email, name);

    let conversionName = null;
    let status = null;

    if (
      eventType === "bill_created" ||
      eventType === "bill_pending"
    ) {
      status = "pendente";
      conversionName = `${baseConversion} pendente`;
      await sendConversion(email, conversionName);
    }

    if (
      eventType === "bill_paid" ||
      eventType === "subscription_activated"
    ) {
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

    saveEventAsync({
      source: "vindi",
      eventType,
      email,
      name,
      productName,
      status,
      conversionName,
      payload,
    }).catch((err) => {
      console.error("Erro ao salvar evento Vindi no banco", err.message);
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("Erro no webhook Vindi", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

/* =========================================================
   HELPERS KIWIFY
========================================================= */

const KIWIFY_WEBHOOK_SECRET = process.env.KIWIFY_WEBHOOK_SECRET || "defina_um_token_forte_aqui";

function extractKiwifyEmail(payload) {
  return (
    payload?.buyer?.email ||
    payload?.data?.buyer?.email ||
    payload?.cliente?.email ||
    null
  );
}

function extractKiwifyBuyerName(payload) {
  return (
    payload?.buyer?.name ||
    payload?.data?.buyer?.name ||
    payload?.cliente?.nome ||
    null
  );
}

function extractKiwifyProductName(payload) {
  return (
    payload?.product?.name ||
    payload?.data?.product?.name ||
    payload?.produto?.nome ||
    null
  );
}

function extractKiwifyTrigger(payload) {
  // boletos, pix, aprovacao, reembolso, cancelamento etc
  return payload?.trigger || payload?.event || null;
}

function extractKiwifyToken(payload) {
  return payload?.token || null;
}

/* =========================================================
   WEBHOOK KIWIFY
========================================================= */

app.post("/webhook/kiwify", async (req, res) => {
  try {
    const payload = req.body;

    console.log("Evento Kiwify recebido", JSON.stringify(payload));

    const receivedToken = extractKiwifyToken(payload);
    if (!receivedToken || receivedToken !== KIWIFY_WEBHOOK_SECRET) {
      console.log("Token invalido no webhook da Kiwify");
      return res.sendStatus(401);
    }

    const email = extractKiwifyEmail(payload);
    const name = extractKiwifyBuyerName(payload);
    const productName = extractKiwifyProductName(payload);
    const trigger = extractKiwifyTrigger(payload);

    if (!email) {
      console.log("Email nao encontrado no payload da Kiwify, ignorando");
      return res.sendStatus(200);
    }

    const baseConversion = resolveConversion(productName);

    if (!baseConversion) {
      console.log("Produto Kiwify sem mapeamento de conversao, ignorando");
      return res.sendStatus(200);
    }

    await createOrUpdateContact(email, name);

    let conversionName = null;
    let status = null;

    if (
      trigger === "boleto_gerado" ||
      trigger === "pix_gerado" ||
      trigger === "carrinho_abandonado"
    ) {
      status = "pendente";
      conversionName = `${baseConversion} pendente`;
      await sendConversion(email, conversionName);
    }

    if (
      trigger === "compra_aprovada" ||
      trigger === "subscription_renewed"
    ) {
      status = "pago";
      conversionName = `${baseConversion} pago`;
      await sendConversion(email, conversionName);
    }

    if (
      trigger === "compra_recusada" ||
      trigger === "compra_reembolsada" ||
      trigger === "chargeback" ||
      trigger === "subscription_canceled" ||
      trigger === "subscription_late"
    ) {
      status = "problema";
      conversionName = `${baseConversion} problema`;
      await sendConversion(email, conversionName);
    }

    saveEventAsync({
      source: "kiwify",
      trigger,
      email,
      name,
      productName,
      status,
      conversionName,
      payload,
    }).catch((err) => {
      console.error("Erro ao salvar evento Kiwify no banco", err.message);
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("Erro no webhook Kiwify", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

/* =========================================================
   REGISTRO DO WEBHOOK NA KIWIFY
========================================================= */

const KIWIFY_API_URL = process.env.KIWIFY_API_URL || "https://api.kiwify.com.br";
const KIWIFY_ACCOUNT_ID = process.env.KIWIFY_ACCOUNT_ID;
const KIWIFY_ACCESS_TOKEN = process.env.KIWIFY_ACCESS_TOKEN;
const KIWIFY_WEBHOOK_URL = process.env.KIWIFY_WEBHOOK_URL || "https://seu_dominio.com/webhook/kiwify";

async function registerKiwifyWebhook() {
  try {
    if (!KIWIFY_ACCOUNT_ID || !KIWIFY_ACCESS_TOKEN) {
      console.log("Variaveis Kiwify nao configuradas, sem registro automatico do webhook");
      return;
    }

    const body = {
      name: "Webhook InfectoCast para RD Station",
      url: KIWIFY_WEBHOOK_URL,
      products: "all",
      triggers: [
        "boleto_gerado",
        "pix_gerado",
        "carrinho_abandonado",
        "compra_recusada",
        "compra_aprovada",
        "compra_reembolsada",
        "chargeback",
        "subscription_canceled",
        "subscription_late",
        "subscription_renewed",
      ],
      token: KIWIFY_WEBHOOK_SECRET,
    };

    const resp = await axios.post(
      `${KIWIFY_API_URL}/webhooks`,
      body,
      {
        headers: {
          "x-kiwify-account-id": KIWIFY_ACCOUNT_ID,
          Authorization: `Bearer ${KIWIFY_ACCESS_TOKEN}`,
        },
      }
    );

    console.log("Webhook Kiwify registrado com sucesso", resp.data);
  } catch (err) {
    console.error("Erro ao registrar webhook na Kiwify", err.response?.data || err.message);
  }
}

app.post("/kiwify/register-webhook", async (_, res) => {
  await registerKiwifyWebhook();
  res.send("Registro de webhook Kiwify disparado, veja os logs do servidor para o resultado");
});

/* =========================================================
   LOOP DO PROCESSADOR
========================================================= */

let processorRunning = false;

function startEventProcessorLoop() {
  if (processorRunning) return;
  processorRunning = true;

  setInterval(async () => {
    try {
      await runProcessor();
    } catch (err) {
      console.error("Erro no processador de eventos", err.message);
    }
  }, 60 * 1000);
}

/* =========================================================
   SERVER
========================================================= */

app.get("/", (_, res) => {
  res.send("Webhook Vindi e Kiwify para RD rodando");
});

app.listen(PORT, () => {
  console.log("Webhook rodando na porta", PORT);
  startEventProcessorLoop();
  // se quiser registrar automaticamente na subida, descomente a linha abaixo uma vez e depois comente de novo
  // registerKiwifyWebhook();
});
