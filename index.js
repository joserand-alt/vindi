const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ==============================
// FUNÇÃO: GERAR ACCESS TOKEN RD
// ==============================

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

// ==============================
// WEBHOOK DA VINDI
// ==============================

app.post("/webhook/vindi", async (req, res) => {
  console.log("WEBHOOK DA VINDI CHEGOU");
  console.log(JSON.stringify(req.body));

  try {
    const payload = req.body;

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

    // 1️⃣ Gera access token válido
    const accessToken = await getAccessToken();

    // 2️⃣ Cria ou atualiza contato no RD Station Marketing
    await axios.put(
      `https://api.rd.services/platform/contacts/email:${email}`,
      {
        email: email,
        name: name,
        tags: ["assinatura-criada-vindi"]
      },
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


