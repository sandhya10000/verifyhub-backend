const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const util = require("util");

const execFileAsync = util.promisify(execFile);

const saveCreditReportLocally = async (
  reportData,
  creditReportId,
  bureau,
  extension = "pdf",
) => {
  if (!reportData) {
    return null;
  }

  const bureauName = String(bureau).trim().toLowerCase();

  const uploadDir = path.join(
    process.cwd(),
    "uploads",
    "credit-reports",
    bureauName,
  );

  await fs.promises.mkdir(uploadDir, {
    recursive: true,
  });

  // ============================================================
  // EXPERIAN
  // API gives Base64 XLSX -> Convert XLSX to PDF
  // ============================================================

  if (bureauName === "experian") {
    const tempDir = path.join(uploadDir, "temp");

    await fs.promises.mkdir(tempDir, {
      recursive: true,
    });

    // ----------------------------------------------------------
    // 1. Clean Base64
    // ----------------------------------------------------------

    let base64Data = String(reportData);

    // Remove data URI prefix if present
    if (base64Data.includes(",")) {
      base64Data = base64Data.split(",")[1];
    }

    // Remove spaces/newlines
    base64Data = base64Data.replace(/\s/g, "");

    // ----------------------------------------------------------
    // 2. Validate Base64
    // ----------------------------------------------------------

    if (!base64Data) {
      throw new Error("Experian Base64 report is empty");
    }

    // ----------------------------------------------------------
    // 3. Base64 -> XLSX Buffer
    // ----------------------------------------------------------

    const xlsxBuffer = Buffer.from(base64Data, "base64");

    if (!xlsxBuffer.length) {
      throw new Error("Invalid Experian Base64 report");
    }

    // XLSX is actually ZIP format and normally starts with PK
    if (
      xlsxBuffer.length < 2 ||
      xlsxBuffer[0] !== 0x50 ||
      xlsxBuffer[1] !== 0x4b
    ) {
      throw new Error(
        "Invalid Experian XLSX file. Base64 data is not a valid XLSX.",
      );
    }

    // ----------------------------------------------------------
    // 4. Temporary XLSX file
    // ----------------------------------------------------------

    const timestamp = Date.now();

    const tempXlsxName = `EXPERIAN_${creditReportId}_${timestamp}.xlsx`;

    const tempXlsxPath = path.join(tempDir, tempXlsxName);

    await fs.promises.writeFile(tempXlsxPath, xlsxBuffer);

    console.log("[EXPERIAN] Temporary XLSX saved:", tempXlsxPath);

    // ----------------------------------------------------------
    // 5. XLSX -> PDF using LibreOffice
    // ----------------------------------------------------------

    try {
      const { stdout, stderr } = await execFileAsync(
        "libreoffice",
        [
          "--headless",
          "--convert-to",
          "pdf",
          "--outdir",
          uploadDir,
          tempXlsxPath,
        ],
        {
          timeout: 120000,
        },
      );

      console.log("[EXPERIAN] LibreOffice stdout:", stdout);

      if (stderr) {
        console.log("[EXPERIAN] LibreOffice stderr:", stderr);
      }
    } catch (error) {
      console.error("[EXPERIAN] LibreOffice conversion error:", error);

      // Delete temp XLSX if conversion fails
      try {
        await fs.promises.unlink(tempXlsxPath);
      } catch (unlinkError) {
        // Ignore cleanup error
      }

      throw new Error("Experian XLSX to PDF conversion failed");
    }

    // ----------------------------------------------------------
    // 6. Find generated PDF
    // ----------------------------------------------------------

    const generatedPdfName = tempXlsxName.replace(/\.xlsx$/i, ".pdf");

    const generatedPdfPath = path.join(uploadDir, generatedPdfName);

    // ----------------------------------------------------------
    // 7. Check PDF exists
    // ----------------------------------------------------------

    if (!fs.existsSync(generatedPdfPath)) {
      // Cleanup XLSX
      try {
        await fs.promises.unlink(tempXlsxPath);
      } catch (error) {
        // Ignore cleanup error
      }

      throw new Error("Experian PDF conversion failed - PDF not found");
    }

    // ----------------------------------------------------------
    // 8. Final PDF name
    // ----------------------------------------------------------

    const finalPdfName = `EXPERIAN_${creditReportId}_${Date.now()}.pdf`;

    const finalPdfPath = path.join(uploadDir, finalPdfName);

    // ----------------------------------------------------------
    // 9. Rename generated PDF
    // ----------------------------------------------------------

    await fs.promises.rename(generatedPdfPath, finalPdfPath);

    // ----------------------------------------------------------
    // 10. Delete temporary XLSX
    // ----------------------------------------------------------

    try {
      await fs.promises.unlink(tempXlsxPath);
    } catch (error) {
      console.warn(
        "[EXPERIAN] Could not delete temporary XLSX:",
        error.message,
      );
    }

    console.log("[EXPERIAN] PDF saved:", finalPdfPath);

    // ----------------------------------------------------------
    // 11. Return DB path
    // ----------------------------------------------------------

    const localPath = path.join(
      "uploads",
      "credit-reports",
      bureauName,
      finalPdfName,
    );

    return localPath.replace(/\\/g, "/");
  }

  // ============================================================
  // ALL OTHER BUREAUS
  // CIBIL / CRIF / EQUIFAX
  // ============================================================

  let fileBuffer;

  // ------------------------------------------------------------
  // CASE 1: PDF URL
  // ------------------------------------------------------------

  if (typeof reportData === "string" && /^https?:\/\//i.test(reportData)) {
    const response = await axios.get(reportData, {
      responseType: "arraybuffer",
      timeout: 60000,
    });

    fileBuffer = Buffer.from(response.data);
  }

  // ------------------------------------------------------------
  // CASE 2: Buffer
  // ------------------------------------------------------------
  else if (Buffer.isBuffer(reportData)) {
    fileBuffer = reportData;
  }

  // ------------------------------------------------------------
  // CASE 3: Base64
  // ------------------------------------------------------------
  else {
    let base64Data = String(reportData);

    // Remove data URI prefix
    if (base64Data.includes(",")) {
      base64Data = base64Data.split(",")[1];
    }

    // Remove spaces/newlines
    base64Data = base64Data.replace(/\s/g, "");

    if (!base64Data) {
      throw new Error(`${bureauName.toUpperCase()} Base64 report is empty`);
    }

    fileBuffer = Buffer.from(base64Data, "base64");
  }

  // ------------------------------------------------------------
  // Validate buffer
  // ------------------------------------------------------------

  if (!fileBuffer || !fileBuffer.length) {
    throw new Error(`${bureauName.toUpperCase()} report file is empty`);
  }

  // ------------------------------------------------------------
  // Save normal PDF
  // ------------------------------------------------------------

  const fileName = `${bureauName.toUpperCase()}_${creditReportId}_${Date.now()}.${extension}`;

  const absolutePath = path.join(uploadDir, fileName);

  await fs.promises.writeFile(absolutePath, fileBuffer);

  console.log(`[${bureauName.toUpperCase()}] Report saved:`, absolutePath);

  // ------------------------------------------------------------
  // Return DB path
  // ------------------------------------------------------------

  const localPath = path.join(
    "uploads",
    "credit-reports",
    bureauName,
    fileName,
  );

  return localPath.replace(/\\/g, "/");
};

module.exports = saveCreditReportLocally;
