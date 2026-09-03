const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const experianReportTemplate = require("../templates/experianReport.template");

const generateExperianPdf = async (result, creditReportId) => {
  let browser;

  try {
    console.log("[EXPERIAN PDF] Starting PDF generation...");

    // Generate HTML from Experian JSON
    const html = experianReportTemplate(result);

    // PDF upload directory
    const uploadDir = path.join(
      process.cwd(),
      "uploads",
      "credit-reports",
      "experian",
    );

    fs.mkdirSync(uploadDir, {
      recursive: true,
    });

    // PDF filename
    const fileName = `experian-${creditReportId}.pdf`;

    const filePath = path.join(uploadDir, fileName);

    console.log("[EXPERIAN PDF] File path:", filePath);

    // Launch Puppeteer
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const page = await browser.newPage();

    // Viewport
    await page.setViewport({
      width: 1200,
      height: 1600,
      deviceScaleFactor: 1,
    });

    console.log("[EXPERIAN PDF] Loading HTML...");

    // IMPORTANT:
    // Do NOT use networkidle0 here.
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Wait for fonts if any
    await page.evaluate(async () => {
      if (document.fonts) {
        await document.fonts.ready;
      }
    });

    console.log("[EXPERIAN PDF] HTML loaded.");

    // Generate PDF
    await page.pdf({
      path: filePath,
      format: "A4",
      printBackground: true,

      margin: {
        top: "10mm",
        right: "8mm",
        bottom: "10mm",
        left: "8mm",
      },

      preferCSSPageSize: false,
    });
    const pdfUrl = `/uploads/credit-reports/experian/${fileName}`;

    console.log("[EXPERIAN PDF] PDF saved successfully:", filePath);

    return pdfUrl;
  } catch (error) {
    console.error("[EXPERIAN PDF] PDF generation error:", error);

    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log("[EXPERIAN PDF] Browser closed.");
    }
  }
};

module.exports = generateExperianPdf;
