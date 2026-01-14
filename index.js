const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// rota que a Vindi vai chamar
app.post("/webhook/vindi", async (req, res) => {
  console.log("WEBHOOK DA VINDI CHEGOU");
  console.log(JSON.stringify(req.body));

  try {
    const payload = req.body;

    // pega o email do cliente da Vindi
    const email =
      payload?.customer?.email ||
      payload?.subscription?.customer?.email;

    const name =
      payload?.customer?.name ||
      payload?.subscription?.customer?.name ||
      "";

    if (!email) {
      return res.status(200).send("email não encontrado");
    }

    // monta o payload para o RD
    const rdPayload = {
      email: email,
      name: name,
      tags: ["assinatura-criada-vindi"]
    };

    // chamada para o RD Station
    await axios.post(
      "https://api.rd.services/platform/contacts",
      rdPayload,
      {
        headers: {
          Authorization: `Bearer ${process.env.RD_API_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.status(200).send("ok");
  } catch (error) {
    console.error("ERRO RD:");
    console.error(error.response?.status);
    console.error(error.response?.data);

    return res.status(200).send("erro tratado");
  }
});

// porta obrigatória no Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Webhook rodando");
});
