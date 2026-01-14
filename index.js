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

    // extrai email e nome do payload REAL da Vindi
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

    // payload para o RD
    const rdPayload = {
      email: email,
      name: name,
      tags: ["assinatura-criada-vindi"]
    };

    // cria ou atualiza contato no RD Station
    await axios.put(
      `https://api.rd.services/platform/contacts/email:${email}`,
      rdPayload,
      {
        headers: {
          Authorization: `Bearer ${process.env.RD_API_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("CONTATO ENVIADO PARA O RD COM SUCESSO");

    return res.status(200).send("ok");
  } catch (error) {
    console.error("ERRO AO ENVIAR PARA O RD");
    console.error(error.response?.status);
    console.error(error.response?.data || error.message);
    return res.status(200).send("erro tratado");
  }
});

// rota simples para teste manual
app.get("/", (req, res) => {
  res.status(200).send("online");
});

// porta obrigatória no Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Webhook rodando");
});
