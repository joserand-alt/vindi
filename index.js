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
// WEBHOOK VINDI
// ======================================================

app.post("/webhook/vindi", async (req, res) => {
  console.log("WEBHOOK DA VINDI CHEGOU");
  console.log(JSON.stringify(req.body));

  try {
    const payload = req.body;
    const eventType = payload?.event?.type;

    // Processa apenas criação de assinatura
    if (eventType !== "subscription_created") {
      console.log("EVENTO IGNORADO:", eventType);
      return res.status(200).send("evento ignorado");
    }

    const subscription = payload?.event?.data?.subscription;
    const customer = subscription?.customer;

    const email = customer?.email;
    const name = customer?.name || "";

    if (!email) {
      console.log("EMAIL NÃO ENCONTRADO");
      return res.status(200).send("email ausente");
    }

    // ==================================================
    // NOME DO PRODUTO / PLANO
    // ==================================================

    const productName =
      subscription?.plan?.name ||
      subscription?.product?.name;

    if (!productName) {
      console.log("PRODUTO NÃO IDENTIFICADO");
    } else {
      console.log("PRODUTO IDENTIFICADO:", productName);
    }

    const accessToken = await getAccessToken();

    // ==================================================
    // PASSO 1 – GARANTE CONTATO (PATCH)
    // ==================================================

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

    // ==================================================
    // PASSO 2 – ADICIONA TAGS
    // ==================================================

    const tags = ["assinatura-criada-vindi"];

    if (productName) {
      tags.push(productName.toLowerCase());
    }

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

    console.log("TAGS APLICADAS:", tags);

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
