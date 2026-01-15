const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

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
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  return response.data.access_token;
}

// ======================================================
// FUNÇÃO AUXILIAR – GARANTIR CONTATO NO RD
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
// FUNÇÃO AUXILIAR – ADICIONAR TAGS
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
// WEBHOOK VINDI
// ======================================================

app.post("/webhook/vindi", async (req, res) => {
  console.log("WEBHOOK DA VINDI CHEGOU");
  console.log(JSON.stringify(req.body));

  try {
    const payload = req.body;
    const eventType = payload?.event?.type;

    const accessToken = await getAccessToken();

    // ==================================================
    // EVENTO: ASSINATURA CRIADA
    // ==================================================

    if (eventType === "subscription_created") {
      const subscription = payload?.event?.data?.subscription;
      const customer = subscription?.customer;

      const email = customer?.email;
      const name = customer?.name || "";

      if (!email) {
        return res.status(200).send("email ausente");
      }

      const productName =
        subscription?.plan?.name ||
        subscription?.product?.name;

      const tags = ["assinatura-criada-vindi"];

      if (productName) {
        tags.push(productName.toLowerCase());
      }

      await ensureContact({ email, name, accessToken });
      await addTags({ email, tags, accessToken });

      console.log("ASSINATURA PROCESSADA");
    }

    // ==================================================
    // EVENTO: COBRANÇA GERADA (BILL CREATED)
    // ==================================================

    if (eventType === "bill_created") {
      const bill = payload?.event?.data?.bill;
      const customer = bill?.customer;

      const email = customer?.email;
      const name = customer?.name || "";

      if (!email) {
        return res.status(200).send("email ausente");
      }

      const billItems = bill?.bill_items || [];

      const productTags = billItems
        .map(item => item?.product?.name)
        .filter(Boolean)
        .map(name => name.toLowerCase());

      const tags = [
        "cobrança gerada",
        ...productTags
      ];

      await ensureContact({ email, name, accessToken });
      await addTags({ email, tags, accessToken });

      console.log("COBRANÇA GERADA PROCESSADA");
    }

    // ==================================================
    // EVENTOS NÃO TRATADOS
    // ==================================================

    if (
      eventType !== "subscription_created" &&
      eventType !== "bill_created"
    ) {
      console.log("EVENTO IGNORADO:", eventType);
    }

    return res.status(200).send("ok");
  } catch (error) {
    console.error("ERRO NO PROCESSAMENTO");

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

