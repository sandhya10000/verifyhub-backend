const axios = require("axios");

class SurepassClient {
  constructor() {
    this.retryAttempts = 2;
    this.retryDelay = 2000;

    // Agar tumhare existing client me already
    // ye values hain, unhe change mat karna.
    this.rateLimit = [];
  }

  /**
   * ==========================================================
   * CREDIT CHECK REQUEST
   * ==========================================================
   */
  async makeCreditCheckRequest(apiKey, endpoint, requestData) {
    return this.makeRequest(apiKey, endpoint, requestData, {
      timeout: 180000,
    });
  }

  /**
   * ==========================================================
   * GENERIC REQUEST
   * ==========================================================
   */
  async makeRequest(apiKey, endpoint, data, options = {}) {
    const {
      method = "POST",

      maxRetries = this.retryAttempts,

      retryDelay = this.retryDelay,
    } = options;

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // ====================================================
        // RATE LIMIT
        // ====================================================

        await this.enforceRateLimit();

        // ====================================================
        // API REQUEST
        // ====================================================

        const response = await axios({
          method,

          url: endpoint,

          data,

          headers: {
            Authorization: `Bearer ${apiKey}`,

            "Content-Type": "application/json",

            ...options.headers,
          },

          timeout: options.timeout || 30000,
        });

        // ====================================================
        // SUCCESS
        // ====================================================

        this.recordSuccessfulRequest();

        return response;
      } catch (error) {
        lastError = error;

        // ====================================================
        // 429 RATE LIMIT
        // ====================================================

        if (error.response?.status === 429) {
          console.warn(
            `Rate limit hit on attempt ${attempt + 1}, waiting longer...`,
          );

          const retryAfter = error.response.headers?.["retry-after"] || 60;

          const delay = Math.max(
            retryAfter * 1000,

            retryDelay * Math.pow(2, attempt),
          );

          await this.delay(delay + Math.random() * 1000);

          continue;
        }

        // ====================================================
        // TEMPORARY ERROR
        // ====================================================

        if (this.isRetryableError(error) && attempt < maxRetries) {
          console.warn(
            `Request failed on attempt ${attempt + 1}, retrying...`,
            error.message,
          );

          const exponentialDelay = retryDelay * Math.pow(2, attempt);

          await this.delay(exponentialDelay + Math.random() * 1000);

          continue;
        }

        // ====================================================
        // NON RETRYABLE
        // ====================================================

        break;
      }
    }

    throw lastError;
  }

  /**
   * ==========================================================
   * DELAY
   * ==========================================================
   */
  async delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * ==========================================================
   * RETRYABLE ERROR
   * ==========================================================
   *
   * IMPORTANT:
   * 401/403 should NOT be retried.
   */
  isRetryableError(error) {
    const status = error.response?.status;

    if (status === 401 || status === 403) {
      return false;
    }

    if (status >= 400 && status < 500) {
      return false;
    }

    return (
      error.code === "ECONNRESET" ||
      error.code === "ETIMEDOUT" ||
      error.code === "ECONNABORTED" ||
      !error.response
    );
  }

  /**
   * ==========================================================
   * RATE LIMIT
   * ==========================================================
   *
   * IMPORTANT:
   * Agar tumhare existing surepassClient me already
   * enforceRateLimit() implementation hai,
   * to wahi existing implementation use karo.
   */
  async enforceRateLimit() {
    // Existing implementation use karo.
    return;
  }

  /**
   * ==========================================================
   * SUCCESS RECORD
   * ==========================================================
   *
   * Agar existing client me implementation hai,
   * wahi use karo.
   */
  recordSuccessfulRequest() {
    // Existing implementation use karo.
  }
}

module.exports = new SurepassClient();
