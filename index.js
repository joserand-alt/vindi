const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ==============================
// CONFIGURAÇÕES RD STATION
// ==============================

const RD_TOKEN_URL = "https://api.rd.services/auth/token";
const RD_CONTACT_URL = "https://api.rd.services/platform/contacts/email:";

// ==============================
// FUNÇÃO: GERAR ACCESS TOKEN
// ==============================

async function getAccessToken() {
  const response = await axios.post(
    RD_TOKEN_URL,
    {
      client_id: process.env.RD_CLIENT_ID,
      client_secret: process.env.RD_CLIENT_SECRET,
      refresh_token: process.env.RD_REFRESH_TOKEN
    },
    {
      headers: {
        "Content-Type": "application/json"
      }
    }
  );

  return response.data.access_token;
}

// ==============================
// WEBHOOK DA VINDI
// ==============================

app.post("/webhook/vindi", async (req, res) => {
  console.log("WEBHOOK DA VINDI CHEGOU");
  console.log(JSON.stringify(req.body));

  try {
    const payload = req.body;

    // Extrai dados do payload REAL da Vindi
    const email =
      payload?.event?.data?.subscription?.customer?.email ||
      payload?.event?.data?.charge?.customer?.email;

    const name =
      payload?.event?.data?.subscription?.customer?.name ||
      payload?.event?.data?.charge?.customer?.name ||
      "";

    if (!email) {
      console.log("EMAIL NÃO ENCONTRADO NO PAYLOAD");
      return res.status(200).send("email não encontrado");
    }

    console.log("EMAIL ENCONTRADO:", email);

    // 1️⃣ Gera access_token usando refresh_token
    const accessToken = await getAccessToken();

    // 2️⃣ Monta payload para o RD
    const rdPayload = {
      email: email,
      name: name,
      tags: ["assinatura-criada-vindi"]
    };

    // 3️⃣ Cria ou atualiza contato no RD Station Marketing
    await axios.put(
      `${RD_CONTACT_URL}${email}`,
      rdPayload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("CONTATO CRIADO / ATUALIZADO NO RD");

    return res.status(200).send("ok");
  } catch (error) {
    console.error("ERRO NO PROCESSAMENTO DO WEBHOOK");

    if (error.response) {
      console.error("STATUS:", error.response.status);
      console.error("DATA:", JSON.stringify(error.response.data));
    } else {
      console.error(error.message);
    }

    // SEMPRE responder 200 para a Vindi
    return res.status(200).send("erro tratado");
  }
});

// ==============================
// ROTA DE TESTE
// ==============================

app.get("/", (req, res) => {
  res.status(200).send("online");
});

// ==============================
// START SERVER
// ==============================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Webhook rodando");
});

