require("dotenv").config();
const { runProcessor } = require("./eventProcessor");

runProcessor()
  .then(() => process.exit())
  .catch(() => process.exit(1));
