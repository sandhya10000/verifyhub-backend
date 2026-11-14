// DISABLED: replaced by Claude analyzer
// const axios = require('axios');
// const fs = require('fs');
// 
// // Finpass Bank Statement Analyzer client. Credentials come from .env
// // (FINPASS_BASE_URL, FINPASS_API_KEY, FINPASS_API_SECRET) and are never logged.
// const TIMEOUT_MS = 60000;
// 
// function config() {
//   const baseUrl = process.env.FINPASS_BASE_URL?.trim();
//   const apiKey = process.env.FINPASS_API_KEY?.trim();
//   const apiSecret = process.env.FINPASS_API_SECRET?.trim();
//   if (!baseUrl || !apiKey || !apiSecret) {
//     const err = new Error('Finpass credentials are not configured');
//     err.code = 'CONFIG_MISSING';
//     throw err;
//   }
//   return {
//     base: baseUrl.replace(/\/$/, ''),
//     headers: { 'X-API-Key': apiKey, 'X-API-Secret': apiSecret },
//   };
// }
// 
// // Upload the statement. Returns the client_id used to fetch the result later.
// async function uploadStatement(filePath) {
//   const { base, headers } = config();
//   const form = new FormData();
//   const bytes = fs.readFileSync(filePath);
//   form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'statement.pdf');
//   form.append('password', '');
// 
//   const res = await axios.post(`${base}/api/v1/services/bsa/upload-statement`, form, {
//     headers,
//     timeout: TIMEOUT_MS,
//   });
//   const clientId = res.data?.data?.client_id;
//   if (!res.data?.success || !clientId) {
//     const err = new Error(res.data?.message || 'Finpass did not return a client_id');
//     err.code = 'EMPTY_RESPONSE';
//     throw err;
//   }
//   return { clientId, docId: res.data?.data?.doc_id || null };
// }
// 
// // Fetch the current analysis state for a client_id. Returns the inner `data`
// // object (status, checkpoint, account_info, analysis_pdf_s3_url, ...).
// async function getResult(clientId) {
//   const { base, headers } = config();
//   const res = await axios.get(`${base}/api/v1/services/bsa/statement-result`, {
//     headers,
//     params: { client_id: clientId },
//     timeout: TIMEOUT_MS,
//   });
//   return res.data?.data || res.data || null;
// }
// 
// // Download the analysis PDF from its presigned S3 link. Rejects anything that
// // does not start with the PDF signature.
// async function downloadPdf(url) {
//   const res = await axios.get(url, { responseType: 'arraybuffer', timeout: TIMEOUT_MS });
//   const buf = Buffer.from(res.data);
//   if (buf.slice(0, 5).toString('latin1') !== '%PDF-') {
//     const err = new Error('Finpass analysis file is not a PDF');
//     err.code = 'EMPTY_RESPONSE';
//     throw err;
//   }
//   return buf;
// }
// 
// module.exports = { uploadStatement, getResult, downloadPdf };
// 