const SUREPASS_CONFIG = {
  baseUrl: process.env.SUREPASS_BASE_URL,
  apiToken: process.env.SUREPASS_API_TOKEN,
  equifaxEndpoint: "/production/api/v1/credit-report-v2/fetch-pdf-report",
  timeout: 60000,
};

module.exports = SUREPASS_CONFIG;
