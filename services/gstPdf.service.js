const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

// Brand mark for the PDF header — read once, embedded as base64 so the
// PDF renders offline. Falls back to text-only header if unreadable.
let logoDataUri = null;
try {
  const logoPath = path.join(process.cwd(), "assets", "logo.jpeg");
  if (fs.existsSync(logoPath)) {
    logoDataUri = `data:image/jpeg;base64,${fs.readFileSync(logoPath).toString("base64")}`;
  }
} catch {
  logoDataUri = null;
}
if (!logoDataUri) console.warn("[GST PDF] assets/logo.jpeg not found — header renders without logo");

const esc = (v) =>
  String(v ?? "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function row(label, value, highlight) {
  return `<tr>
    <td style="padding:9px 12px;border:1px solid #e5e9f2;color:#64748b;width:42%">${esc(label)}</td>
    <td style="padding:9px 12px;border:1px solid #e5e9f2;color:#0f1e3d;font-weight:${highlight ? "800" : "600"}">${esc(value)}</td>
  </tr>`;
}

function section(title, rows) {
  return `<h2 style="font-size:15px;color:#0f1e3d;margin:22px 0 8px">${esc(title)}</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px">${rows.join("")}</table>`;
}

function placeLine(pl) {
  if (!pl) return "—";
  const parts = [pl.adr, pl.ntr, pl.mb, pl.em].filter((v) => v !== null && v !== undefined && v !== "" && v !== "NA");
  return parts.length ? parts.join(" · ") : "—";
}

function buildGstHtml(result, verificationId) {
  const t = result.taxpayerDetails || {};
  const ret = result.taxpayerReturnDetails || {};
  const filings = ret.filingStatus || [];
  const delay = ret.gst_filing_delay_summary || {};
  const gaps = ret.gst_filing_gap || [];
  const goods = result.goods_service?.bzgddtls || [];
  const places = result.business_places || {};
  const shown = filings.slice(0, 40);
  const members = Array.isArray(t.mbr) ? t.mbr.filter(Boolean) : [];
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
  <body style="font-family:Arial,sans-serif;color:#0f1e3d;margin:0;padding:8px">
    <div style="background:#1d4ed8;color:#fff;border-radius:10px;padding:20px 24px">
      <div style="display:flex;align-items:center;gap:12px">
        ${logoDataUri ? `<img src="${logoDataUri}" alt="VerifyHub" style="width:42px;height:42px;border-radius:8px;display:block" />` : ""}
        <div style="font-size:26px;font-weight:800;line-height:1.2">VerifyHub</div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-top:4px">
        <div style="font-size:13px;opacity:0.9">GST Verification — Advanced</div>
        <div style="font-size:13px;font-weight:600;white-space:nowrap;opacity:0.95">${esc(t.gstin || "")} · ${new Date().toLocaleDateString("en-GB")}</div>
      </div>
    </div>
    ${section("Taxpayer Details", [
      row("Legal Name", t.lgnm, true),
      row("GSTIN", t.gstin),
      row("Trade Name", t.tradeNam),
      row("Constitution", t.ctb),
      row("Taxpayer Type", t.dty),
      row("Status", t.sts),
      row("Registration Date", t.rgdt),
      row("Turnover Slab", t.aggreTurnOver),
      row("E-invoice Status", t.einvoiceStatus),
      row("Field Visit", t.isFieldVisitConducted),
      row("Members / Directors", members.length ? members.join("; ") : "—"),
      row("Jurisdiction (State)", t.stj),
      row("Jurisdiction (Centre)", t.ctj),
    ])}
    ${section("Business Places", [
      row("Principal Place", placeLine(places.pradr)),
      ...((places.adadr || []).slice(0, 5).map((a, i) => row("Additional Place " + (i + 1), placeLine(a)))),
    ])}
    <h2 style="font-size:15px;color:#0f1e3d;margin:22px 0 8px">Filing Compliance (recent ${shown.length}${filings.length > 40 ? " of " + filings.length : ""} · delayed overall: ${delay.gst_delay_count_overall ?? "—"})</h2>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr style="background:#f4f6fa">
        <td style="padding:7px 10px;border:1px solid #e5e9f2;font-weight:800">FY</td>
        <td style="padding:7px 10px;border:1px solid #e5e9f2;font-weight:800">Period</td>
        <td style="padding:7px 10px;border:1px solid #e5e9f2;font-weight:800">Return</td>
        <td style="padding:7px 10px;border:1px solid #e5e9f2;font-weight:800">Filed On</td>
        <td style="padding:7px 10px;border:1px solid #e5e9f2;font-weight:800">Status</td>
        <td style="padding:7px 10px;border:1px solid #e5e9f2;font-weight:800">Delayed</td>
      </tr>
      ${shown.map((f) => "<tr>"
        + "<td style=\"padding:7px 10px;border:1px solid #e5e9f2\">" + esc(f.fy) + "</td>"
        + "<td style=\"padding:7px 10px;border:1px solid #e5e9f2\">" + esc(f.taxp) + "</td>"
        + "<td style=\"padding:7px 10px;border:1px solid #e5e9f2\">" + esc(f.rtntype) + "</td>"
        + "<td style=\"padding:7px 10px;border:1px solid #e5e9f2\">" + esc(f.dof) + "</td>"
        + "<td style=\"padding:7px 10px;border:1px solid #e5e9f2\">" + esc(f.status) + "</td>"
        + "<td style=\"padding:7px 10px;border:1px solid #e5e9f2\">" + (f.is_delayed ? "Yes" : "No") + "</td>"
        + "</tr>").join("")}
    </table>
    ${gaps.length ? "<p style=\"font-size:12px;color:#8a94ad\">Filing gaps: " + esc(gaps.map((g) => [g.rtntype, g.month, g.fy].filter(Boolean).join(" ")).join("; ")) + "</p>" : ""}
    ${section("Goods & Services", goods.length ? goods.slice(0, 10).map((g) => row(g.hsncd ? "HSN " + g.hsncd : "Description", g.gdes)) : [row("Goods / Services", "—")])}
    <p style="font-size:11px;color:#8a94ad;margin-top:24px">Verification ID: ${esc(verificationId)} · Generated by VerifyHub via IndiConnect. Data as returned by the issuing authority.</p>
  </body></html>`;
}
async function generateGstPdf(result, verificationId) {
  let browser = null;
  try {
    const uploadDir = path.join(process.cwd(), "uploads", "gst");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const fileName = `gst-${String(verificationId)}-${Date.now()}.pdf`;
    const filePath = path.join(uploadDir, fileName);

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1800, deviceScaleFactor: 1 });
    await page.setContent(buildGstHtml(result || {}, verificationId), { waitUntil: "networkidle0" });
    await page.evaluate(async () => {
      if (document.fonts) await document.fonts.ready;
    });
    await page.pdf({
      path: filePath,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="width:100%;font-size:8px;padding:0 25px;color:#777;font-family:Arial,sans-serif">GST Verification</div>`,
      footerTemplate: `<div style="width:100%;font-size:8px;padding:0 25px;color:#777;text-align:center;font-family:Arial,sans-serif">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
      margin: { top: "45px", bottom: "45px", left: "25px", right: "25px" },
    });
    await browser.close();
    browser = null;

    return {
      success: true,
      fileName,
      filePath,
      relativePath: `/uploads/gst/${fileName}`,
      pdfUrl: `/uploads/gst/${fileName}`,
    };
  } catch (error) {
    console.error("[GST PDF] Generation error:", error);
    if (browser) {
      try {
        await browser.close();
      } catch { /* ignore */ }
    }
    return { success: false, error: error.message };
  }
}

module.exports = { generateGstPdf, buildGstHtml };
