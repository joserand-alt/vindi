// productNormalizer.js

function normalizeProductName(raw) {
  if (!raw) return null;

  const name = raw.toLowerCase();

  if (name.includes("multi-r")) return "Jornada Multi R";
  if (name.includes("multi r")) return "Jornada Multi R";

  if (name.includes("ccih") || name.includes("infecção")) {
    return "Pós graduação CCIH";
  }

  if (name.includes("orto")) {
    return "Pós graduação Ortopedia";
  }

  if (name.includes("imuno")) {
    return "Pós graduação Imunodeprimidos";
  }

  if (name.includes("pediatria")) {
    return "Pós graduação Pediatria";
  }

  if (name.includes("infectoped")) {
    return "Pós graduação Pediatria";
  }

  if (name.includes("fungo")) {
    return "Do Fungo ao Antifúngico";
  }

  return raw.trim();
}

module.exports = { normalizeProductName };