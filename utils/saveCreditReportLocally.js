const axios = require("axios");
const fs = require("fs");
const path = require("path");

const saveCreditReportLocally = async (
  reportUrl,
  creditReportId,
  bureau,
  extension = "pdf",
) => {
  if (!reportUrl) {
    return null;
  }

  // Normalize bureau name
  const bureauName = String(bureau).trim().toLowerCase();

  const uploadDir = path.join(
    process.cwd(),
    "uploads",
    "credit-reports",
    bureauName,
  );

  // Folder create karega agar exist nahi karta
  await fs.promises.mkdir(uploadDir, {
    recursive: true,
  });

  // Filename
  const fileName = `${bureauName.toUpperCase()}_${creditReportId}_${Date.now()}.${extension}`;

  const absolutePath = path.join(uploadDir, fileName);

  // Report download
  const response = await axios.get(reportUrl, {
    responseType: "arraybuffer",
    timeout: 60000,
  });

  // File save
  await fs.promises.writeFile(absolutePath, response.data);

  // DB me relative path
  const localPath = path.join(
    "uploads",
    "credit-reports",
    bureauName,
    fileName,
  );

  return localPath.replace(/\\/g, "/");
};

module.exports = saveCreditReportLocally;
