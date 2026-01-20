const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

/* =========================================================
   CONFIGURAÇÕES RD STATION (OAuth)
========================================================= */

let rdAccessToken = null;
let rdTokenExpiresAt = null;

async function getRdAccessToken() {
  if (rdAccessToken && rdTokenExpiresAt > Date.now()) {
    return rdAccessToken;
  }

  console.log('🔄 Renovando access token da RD...');

  const response = await axios.post(
    'https://api.rd.services/auth/token',
    {
      client_id: process.env.RD_CLIENT_ID,
      client_secret: process.env.RD_CLIENT_SECRET,
      refresh_token: process.env.RD_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    }
  );

  rdAccessToken = response.data.access_token;
  rdTokenExpiresAt = Date.now() + (response.data.expires_in - 60) * 1000;

  if (response.data.refresh_token) {
    process.env.RD_REFRESH_TOKEN = response.data.refresh_token;
    console.log('🔁 Novo refresh token gerado — salve no Render');
  }

  return rdAccessToken;
}

/* =========================================================
   TABELA DE MAPEAMENTO (CONTÉM TEXTO → CONVERSÃO)
========================================================= */

const conversionMap = [
  { match: 'ortopéd', conversion: 'Pós-graduação Orto' },
  { match: 'inunodeprimido', conversion: 'Pós-graduação Imuno' },
  { match: 'imunodeprimido', conversion: 'Pós-graduação Imuno' },
  { match: 'infecção hospitalar', conversion: 'Pós-graduação ccih' },
  { match: 'ccih', conversion: 'Pós-graduação ccih' },
  { match: 'pediatria', conversion: 'Pós-graduação Pediatria' },
  { match: 'multi-r', conversion: 'Jornada Multi-R' }
];

function resolveConversion(productName) {
  if (!productName) return null;

  const name = productName.toLowerCase();

  const found = conversionMap.find(item =>
    name.includes(item.match)
  );

  return found ? found.conversion : null;
}

/* =========================================================
   HELPERS
========================================================= */

function extractEmail(payload) {
  return (
    payload?.event?.data?.customer?.email ||
    payload?.event?.data?.bill?.customer?.email ||
    payload?.event?.data?.subscription?.customer?.email ||
    null
  );
}

function extractProductName(payload) {
  return (
    payload?.event?.data?.bill?.bill_items?.[0]?.product?.name ||
    payload?.event?.data?.subscription?.plan?.name ||
    null
  );
}

async function createOrUpdateContact(email) {
  const token = await getRdAccessToken();

  try {
    await axios.patch(
      `https://api.rd.services/platform/contacts/email:${email}`,
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    if (err.response?.status === 404) {
      await axios.post(
        'https://api.rd.services/platform/contacts',
        { email },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } else {
      throw err;
    }
  }
}

async function sendConversion(email, conversionName) {
  const token = await getRdAccessToken();

  console.log(`🚀 ENVIANDO CONVERSÃO PARA RD: ${conversionName}`);

  await axios.post(
    'https://api.rd.services/platform/events',
    {
      event_type: 'CONVERSION',
      event_family: 'CDP',
      payload: {
        conversion_identifier: conversionName.toLowerCase().replace(/\s+/g, '-'),
        email
      }
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

/* =========================================================
   WEBHOOK VINDI
========================================================= */

app.post('/webhook/vindi', async (req, res) => {
  try {
    const eventType = req.body?.event?.type;
    console.log(`📩 EVENTO RECEBIDO: ${eventType}`);

    const email = extractEmail(req.body);
    if (!email) {
      console.log('⚠️ EMAIL NÃO ENCONTRADO — ignorando');
      return res.sendStatus(200);
    }

    const productName = extractProductName(req.body);
    console.log('📦 PRODUTO:', productName);

    const baseConversion = resolveConversion(productName);
    if (!baseConversion) {
      console.log('⚠️ Produto sem mapeamento — ignorado');
      return res.sendStatus(200);
    }

    await createOrUpdateContact(email);

    if (eventType === 'subscription_created' || eventType === 'bill_created') {
      await sendConversion(email, `${baseConversion} - pendente`);
    }

    if (eventType === 'bill_paid') {
      await sendConversion(email, `${baseConversion} - pago`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ ERRO WEBHOOK:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

/* =========================================================
   SERVER
========================================================= */

app.get('/', (_, res) => {
  res.send('Webhook Vindi → RD rodando');
});

app.listen(PORT, () => {
  console.log('🚀 Webhook rodando na porta', PORT);
});

