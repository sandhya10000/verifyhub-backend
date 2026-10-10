const Setting = require("../models/Setting");

const getSurepassApiKeyValue = async () => {
  try {
    const setting = await Setting.findOne({
      key: "surepass_api_key",
    });

    return setting
      ? String(setting.value || "").trim()
      : String(process.env.SUREPASS_API_KEY || "").trim();
  } catch (error) {
    console.error("Error fetching Surepass API key:", error.message);

    return null;
  }
};

module.exports = {
  getSurepassApiKeyValue,
};
