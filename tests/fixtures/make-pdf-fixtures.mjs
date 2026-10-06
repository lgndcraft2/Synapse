// Generates the PDF fixtures used by the viewer tests. No dependencies: the
// PDFs are written by hand (uncompressed content streams, standard 14 font).
//
//   node tests/fixtures/make-pdf-fixtures.mjs
//
// sample.pdf     3 pages of selectable text + 1 image-only ("scanned") page
// protected.pdf  1 text page, RC4 40-bit (Standard handler R2), user password "synapse"
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SAMPLE_TEXT = [
  [
    'Synapse Test Paper',
    'Photosynthesis converts light energy into chemical energy stored in glucose.',
    'Chlorophyll absorbs mostly blue and red light and reflects green light.',
    'The Calvin cycle fixes carbon dioxide into three-carbon sugars.',
  ],
  [
    'Cellular Respiration',
    'Cellular respiration releases the energy stored in glucose as ATP.',
    'Glycolysis happens in the cytoplasm and splits glucose into pyruvate.',
    'The electron transport chain pumps protons across the inner membrane.',
  ],
  [
    'Summary',
    'Plants make sugars and almost every organism burns them for energy.',
    'Energy flows through ecosystems while matter is recycled.',
  ],
];

export const PASSWORD = 'synapse';

function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function textPageContent(lines) {
  const [title, ...body] = lines;
  let s = 'BT\n/F1 24 Tf\n72 720 Td\n(' + esc(title) + ') Tj\nET\n';
  s += 'BT\n/F1 13 Tf\n18 TL\n72 680 Td\n';
  body.forEach((l, i) => { s += (i ? 'T*\n' : '') + '(' + esc(l) + ') Tj\n'; });
  s += 'ET\n';
  return s;
}

function imagePageContent() {
  return 'q\n468 0 0 300 72 400 cm\n/Im1 Do\nQ\n';
}

function grayImage(w, h) {
  const px = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) px[y * w + x] = ((x * 4) ^ (y * 4)) & 0xff;
  }
  return px;
}

// ── RC4 / Standard security handler (R2, 40-bit) ────────────────
const PAD = Buffer.from(
  '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');

function rc4(key, data) {
  const S = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0; j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
    out[k] = data[k] ^ S[(S[i] + S[j]) & 0xff];
  }
  return out;
}

const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
const padPw = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);

function standardSecurity(userPw, ownerPw, id0) {
  const P = -44; // print + copy allowed; no modification
  const O = rc4(md5(padPw(ownerPw)).subarray(0, 5), padPw(userPw));
  const pBuf = Buffer.alloc(4);
  pBuf.writeInt32LE(P);
  const key = md5(padPw(userPw), O, pBuf, id0).subarray(0, 5);
  const U = rc4(key, PAD);
  return { P, O, U, key };
}

function objectKey(key, num, gen) {
  const b = Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]);
  return md5(key, b).subarray(0, Math.min(key.length + 5, 16));
}

// ── PDF writer ───────────────────────────────────────────────────
/**
 * pages: [{ content: string, image?: { w, h, data } }]
 * opts.encrypt: { userPw, ownerPw }
 */
function buildPdf(pages, opts = {}) {
  const objs = []; // index = obj number - 1; { dict?, stream?: Buffer } or raw string
  const add = (o) => { objs.push(o); return objs.length; };

  const catalog = add(null);
  const pagesObj = add(null);
  const font = add({ raw: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' });
  const kids = [];
  for (const p of pages) {
    const contentNum = add({ stream: Buffer.from(p.content, 'latin1'), dict: '' });
    let xobj = '';
    if (p.image) {
      const imgNum = add({
        stream: p.image.data,
        dict: `/Type /XObject /Subtype /Image /Width ${p.image.w} /Height ${p.image.h} /ColorSpace /DeviceGray /BitsPerComponent 8`,
      });
      xobj = ` /XObject << /Im1 ${imgNum} 0 R >>`;
    }
    const pageNum = add({
      raw: `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${font} 0 R >>${xobj} >> /Contents ${contentNum} 0 R >>`,
    });
    kids.push(pageNum);
  }
  objs[catalog - 1] = { raw: `<< /Type /Catalog /Pages ${pagesObj} 0 R >>` };
  objs[pagesObj - 1] = { raw: `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>` };

  const id0 = crypto.createHash('md5').update(JSON.stringify(pages.map(p => p.content)) + (opts.encrypt ? 'enc' : '')).digest();
  let sec = null;
  let encryptNum = null;
  if (opts.encrypt) {
    sec = standardSecurity(opts.encrypt.userPw, opts.encrypt.ownerPw, id0);
    encryptNum = add({
      raw: `<< /Filter /Standard /V 1 /R 2 /O <${sec.O.toString('hex')}> /U <${sec.U.toString('hex')}> /P ${sec.P} >>`,
      plain: true,
    });
  }

  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    const num = i + 1;
    offsets.push(offset);
    let body;
    if (o.stream) {
      let data = o.stream;
      if (sec) data = rc4(objectKey(sec.key, num, 0), data);
      body = Buffer.concat([
        Buffer.from(`${num} 0 obj\n<< ${o.dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
        data,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]);
    } else {
      body = Buffer.from(`${num} 0 obj\n${o.raw}\nendobj\n`, 'latin1');
    }
    chunks.push(body);
    offset += body.length;
  });

  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const idHex = id0.toString('hex');
  const trailer = `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R` +
    (encryptNum ? ` /Encrypt ${encryptNum} 0 R` : '') +
    ` /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, 'latin1'));
  return Buffer.concat(chunks);
}

export function samplePdf() {
  const pages = SAMPLE_TEXT.map(lines => ({ content: textPageContent(lines) }));
  pages.push({ content: imagePageContent(), image: { w: 64, h: 64, data: grayImage(64, 64) } });
  return buildPdf(pages);
}

export function protectedPdf() {
  return buildPdf(
    [{ content: textPageContent(['Protected Notes', 'This secret page explains enzymes and activation energy.']) }],
    { encrypt: { userPw: PASSWORD, ownerPw: 'owner-' + PASSWORD } }
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(HERE, 'sample.pdf'), samplePdf());
  fs.writeFileSync(path.join(HERE, 'protected.pdf'), protectedPdf());
  console.log('Wrote sample.pdf and protected.pdf to', HERE);
}
