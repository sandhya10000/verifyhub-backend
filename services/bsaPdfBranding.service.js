// DISABLED: replaced by Claude analyzer
// const path = require('path');
// const fs = require('fs');
// const { pathToFileURL } = require('url');
// const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
// 
// // Replaces the Finpass branding in the Finpass analysis PDF with VerifyHub's:
// //   - the Finpass logo block in the page 1 header (top-left)
// //   - the Finpass logo block in the last-page footer card (top-left)
// //   - the "© 2026 FinPass" copyright line on the last page
// //
// // The Finpass logos are embedded images, not text, so they are located from the
// // page's image placements (pdfjs-dist, legacy build). The
// // placement rules were derived from the sample analysis PDF. If a rule finds
// // nothing, the service throws BRANDING_ANCHOR_MISSING and the caller marks the
// // analysis Failed rather than delivering a Finpass-branded file.
// 
// const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.jpeg');
// const COPYRIGHT_RE = /©/;
// 
// // pdfjs-dist (legacy build runs in Node without a DOM). Loaded once, lazily.
// let pdfjsPromise = null;
// function loadPdfJs() {
//   if (!pdfjsPromise) {
//     const url = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
//     pdfjsPromise = import(url);
//   }
//   return pdfjsPromise;
// }
// 
// // Multiply two PDF matrices [a b c d e f] (row-vector convention).
// const mul = (m, n) => [
//   m[0] * n[0] + m[1] * n[2],
//   m[0] * n[1] + m[1] * n[3],
//   m[2] * n[0] + m[3] * n[2],
//   m[2] * n[1] + m[3] * n[3],
//   m[4] * n[0] + m[5] * n[2] + n[4],
//   m[4] * n[1] + m[5] * n[3] + n[5],
// ];
// 
// // Per page: image placements (x, y, w, h in PDF points, origin bottom-left),
// // text items, and page height. Only real drawn images are kept (not shading).
// async function readLayout(buffer) {
//   const pdfjs = await loadPdfJs();
//   const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, isEvalSupported: false }).promise;
//   const OPS = pdfjs.OPS;
//   const pages = [];
//   for (let p = 1; p <= doc.numPages; p += 1) {
//     const page = await doc.getPage(p);
//     const [, , pw, ph] = page.view;
//     const content = await page.getTextContent();
//     const text = content.items.map((it) => ({
//       str: it.str || '',
//       x: it.transform[4],
//       y: it.transform[5],
//       w: it.width || 0,
//       h: it.height || 0,
//     }));
// 
//     const ops = await page.getOperatorList();
//     const images = [];
//     let ctm = [1, 0, 0, 1, 0, 0];
//     const stack = [];
//     ops.fnArray.forEach((fn, i) => {
//       const args = ops.argsArray[i];
//       if (fn === OPS.save) stack.push(ctm.slice());
//       else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
//       else if (fn === OPS.transform) ctm = mul(args, ctm);
//       else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintInlineImageXObject) {
//         const w = Math.abs(ctm[0]);
//         const h = Math.abs(ctm[3]);
//         if (w > 5 && h > 5) images.push({ x: ctm[4], y: ctm[5], w, h });
//       }
//     });
//     pages.push({ page: p, pw, ph, text, images });
//   }
//   return { pages, doc };
// }
// 
// // Union box of a set of placements.
// function unionBox(list) {
//   const x0 = Math.min(...list.map((b) => b.x));
//   const y0 = Math.min(...list.map((b) => b.y));
//   const x1 = Math.max(...list.map((b) => b.x + b.w));
//   const y1 = Math.max(...list.map((b) => b.y + b.h));
//   return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
// }
// 
// // Page 1 header: the Finpass logo sits in a small white rounded box at the
// // top-left of the dark banner. Measured from the rendered sample (points,
// // origin bottom-left). The banner and the wordmark images are only present on
// // the Finpass template, so their presence is checked first.
// const HEADER_BOX = { x: 49.5, y: 769.5, w: 75, h: 30 };
// function headerLogoBox(layout) {
//   const { ph } = layout;
//   const present = layout.images.some((b) => b.y > ph - 120 && b.x < 200 && b.w <= 200 && b.h <= 60);
//   return present ? HEADER_BOX : null;
// }
// 
// // Last-page footer: the Finpass wordmark image sits on the footer card at the
// // top-left. Its position moves with the length of the report, so it is found
// // by size and location rather than fixed coordinates.
// function footerLogoBox(layout) {
//   const hits = layout.images.filter((b) => b.x < 120 && b.w >= 30 && b.w <= 60 && b.h >= 10 && b.h <= 20);
//   return hits.length ? unionBox(hits) : null;
// }
// 
// // Header banner colour either side of the Finpass logo box, sampled from the
// // Finpass template at mid-height (RGB 0-255). Interpolated across the box.
// const BANNER_STOPS = [
//   [42, [39, 38, 113]],
//   [138, [22, 37, 119]],
// ];
// function bannerColorAt(x) {
//   const first = BANNER_STOPS[0];
//   const last = BANNER_STOPS[BANNER_STOPS.length - 1];
//   if (x <= first[0]) return rgb(...first[1].map((v) => v / 255));
//   if (x >= last[0]) return rgb(...last[1].map((v) => v / 255));
//   for (let i = 0; i < BANNER_STOPS.length - 1; i += 1) {
//     const [x0, c0] = BANNER_STOPS[i];
//     const [x1, c1] = BANNER_STOPS[i + 1];
//     if (x >= x0 && x <= x1) {
//       const t = (x - x0) / (x1 - x0);
//       return rgb(...c0.map((v, k) => (v + (c1[k] - v) * t) / 255));
//     }
//   }
//   return rgb(0.2, 0.2, 0.45);
// }
// 
// // Pale footer-card fill (sampled from the sample PDF).
// const CARD_FILL = rgb(0.957, 0.965, 0.984);
// 
// // Copyright line: the "©" glyph plus the text on the same baseline to its right.
// function copyrightBox(layout) {
//   const mark = layout.text.find((t) => COPYRIGHT_RE.test(t.str));
//   if (!mark) return null;
//   const line = layout.text.filter((t) => Math.abs(t.y - mark.y) < 3 && t.x >= mark.x - 2);
//   return unionBox(line.map((t) => ({ x: t.x, y: t.y, w: t.w || 4, h: t.h || 6 })));
// }
// 
// async function rebrandFinpassPdf(buffer) {
//   const { pages, doc: pdfjsDoc } = await readLayout(buffer);
//   const pageCount = pages.length;
//   pdfjsDoc.destroy?.();
// 
//   const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
//   const pdfPages = doc.getPages();
//   const font = await doc.embedFont(StandardFonts.Helvetica);
//   const logo = await doc.embedJpg(fs.readFileSync(LOGO_PATH));
// 
//   const first = pages[0];
//   const last = pages[pageCount - 1];
// 
//   const header = headerLogoBox(first);
//   if (!header) {
//     const err = new Error('Finpass header logo not found on page 1');
//     err.code = 'BRANDING_ANCHOR_MISSING';
//     throw err;
//   }
//   const footer = footerLogoBox(last);
//   if (!footer) {
//     const err = new Error(`Finpass footer logo not found on page ${pageCount}`);
//     err.code = 'BRANDING_ANCHOR_MISSING';
//     throw err;
//   }
// 
//   // Header: paint over the Finpass logo box with the banner's own colour so it
//   // blends into the header, then place the VerifyHub logo (square) inside it.
//   const hp = pdfPages[0];
//   // Painted a few points larger than the box so the original drop shadow is covered too.
//   const bleed = 3;
//   for (let x = header.x - bleed; x < header.x + header.w + bleed; x += 1) {
//     hp.drawRectangle({ x, y: header.y - bleed, width: 1.2, height: header.h + bleed * 2, color: bannerColorAt(x + 0.5) });
//   }
//   const hSide = header.h - 4;
//   hp.drawImage(logo, { x: header.x + (header.w - hSide) / 2, y: header.y + 2, width: hSide, height: hSide });
// 
//   // Footer: cover the wordmark with the card fill, VerifyHub logo in its place.
//   const fp = pdfPages[pageCount - 1];
//   fp.drawRectangle({ x: footer.x - 3, y: footer.y - 3, width: footer.w + 6, height: footer.h + 6, color: CARD_FILL });
//   const fSide = 22;
//   fp.drawImage(logo, {
//     x: footer.x - 2,
//     y: footer.y + footer.h / 2 - fSide / 2,
//     width: fSide,
//     height: fSide,
//   });
// 
//   // Copyright line: white over the old text, centred VerifyHub line.
//   const copy = copyrightBox(last);
//   if (copy) {
//     fp.drawRectangle({ x: copy.x - 3, y: copy.y - 3, width: copy.w + 6, height: copy.h + 6, color: rgb(1, 1, 1) });
//     const text = '© 2026 VerifyHub';
//     const size = 6.5;
//     const width = font.widthOfTextAtSize(text, size);
//     fp.drawText(text, {
//       x: last.pw / 2 - width / 2,
//       y: copy.y,
//       size,
//       font,
//       color: rgb(0.32, 0.36, 0.48),
//     });
//   }
// 
//   const out = await doc.save();
//   return { buffer: Buffer.from(out), pageCount };
// }
// 
// module.exports = { rebrandFinpassPdf };
// 