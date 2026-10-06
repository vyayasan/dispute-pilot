import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import jpeg from "jpeg-js";

export interface EvidenceArtifact {
  name: string;
  kind: "jpg" | "pdf";
  bytes: Uint8Array;
}

const SAFE_TEXT = (value: unknown): string => String(value ?? "unknown")
  .replace(/[\r\n\t]+/g, " ")
  .replace(/[^\x20-\x7e]/g, "?")
  .slice(0, 500);

export async function renderPdf(name: string, title: string, lines: string[]): Promise<EvidenceArtifact> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(SAFE_TEXT(title));
  pdf.setAuthor("Dispute Pilot");
  pdf.setSubject("Dispute evidence");
  pdf.setProducer("Dispute Pilot evidence renderer");
  const fixedDate = new Date("2000-01-01T00:00:00.000Z");
  pdf.setCreationDate(fixedDate);
  pdf.setModificationDate(fixedDate);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize: [number, number] = [612, 792];
  let page = pdf.addPage(pageSize);
  let y = 748;
  page.drawText(SAFE_TEXT(title), { x: 48, y, size: 16, font: bold, color: rgb(0.08, 0.18, 0.32) });
  y -= 32;
  for (const line of lines) {
    const text = SAFE_TEXT(line);
    const chunks = text.match(/.{1,92}(?:\s|$)|.{1,92}/g) ?? [""];
    for (const chunk of chunks) {
      if (y < 48) {
        page = pdf.addPage(pageSize);
        y = 748;
      }
      page.drawText(chunk.trimEnd(), { x: 48, y, size: 10, font, color: rgb(0.12, 0.12, 0.12) });
      y -= 15;
    }
  }
  const bytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false });
  return { name, kind: "pdf", bytes };
}

// A compact monochrome-ish raster evidence card. Text is drawn with a tiny
// built-in bitmap font, avoiding native canvas dependencies and PNG output.
const FONT: Record<string, string[]> = {
  A:["01110","10001","10001","11111","10001","10001","10001"], B:["11110","10001","10001","11110","10001","10001","11110"], C:["01111","10000","10000","10000","10000","10000","01111"], D:["11110","10001","10001","10001","10001","10001","11110"], E:["11111","10000","10000","11110","10000","10000","11111"], F:["11111","10000","10000","11110","10000","10000","10000"], G:["01111","10000","10000","10111","10001","10001","01111"], H:["10001","10001","10001","11111","10001","10001","10001"], I:["11111","00100","00100","00100","00100","00100","11111"], J:["00111","00010","00010","00010","10010","10010","01100"], K:["10001","10010","10100","11000","10100","10010","10001"], L:["10000","10000","10000","10000","10000","10000","11111"], M:["10001","11011","10101","10101","10001","10001","10001"], N:["10001","11001","10101","10011","10001","10001","10001"], O:["01110","10001","10001","10001","10001","10001","01110"], P:["11110","10001","10001","11110","10000","10000","10000"], Q:["01110","10001","10001","10001","10101","10010","01101"], R:["11110","10001","10001","11110","10100","10010","10001"], S:["01111","10000","10000","01110","00001","00001","11110"], T:["11111","00100","00100","00100","00100","00100","00100"], U:["10001","10001","10001","10001","10001","10001","01110"], V:["10001","10001","10001","10001","10001","01010","00100"], W:["10001","10001","10001","10101","10101","10101","01010"], X:["10001","10001","01010","00100","01010","10001","10001"], Y:["10001","10001","01010","00100","00100","00100","00100"], Z:["11111","00001","00010","00100","01000","10000","11111"],
  "0":["01110","10001","10011","10101","11001","10001","01110"], "1":["00100","01100","00100","00100","00100","00100","01110"], "2":["01110","10001","00001","00010","00100","01000","11111"], "3":["11110","00001","00001","01110","00001","00001","11110"], "4":["00010","00110","01010","10010","11111","00010","00010"], "5":["11111","10000","10000","11110","00001","00001","11110"], "6":["01110","10000","10000","11110","10001","10001","01110"], "7":["11111","00001","00010","00100","01000","01000","01000"], "8":["01110","10001","10001","01110","10001","10001","01110"], "9":["01110","10001","10001","01111","00001","00001","01110"],
  "-" :["00000","00000","00000","11111","00000","00000","00000"], ":":["00000","00100","00100","00000","00100","00100","00000"], ".":["00000","00000","00000","00000","00000","00100","00100"], "/":["00001","00010","00010","00100","01000","01000","10000"], "?" :["01110","10001","00001","00010","00100","00000","00100"], " ":["00000","00000","00000","00000","00000","00000","00000"]
};

export function renderJpeg(name: string, title: string, lines: string[]): EvidenceArtifact {
  const width = 720, height = 360, scale = 3;
  const data = Buffer.alloc(width * height * 4, 255);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const pixel = (x: number, y: number, shade: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = shade; data[i + 1] = shade; data[i + 2] = shade;
  };
  const drawLine = (value: string, x: number, y: number, factor: number) => {
    let cursor = x;
    for (const char of SAFE_TEXT(value).toUpperCase()) {
      const glyph = FONT[char] ?? FONT["?"]!;
      for (let row = 0; row < glyph.length; row++) for (let col = 0; col < glyph[row]!.length; col++) {
        if (glyph[row]![col] === "1") for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) pixel(cursor + col * factor + dx, y + row * factor + dy, 25);
      }
      cursor += 6 * factor;
      if (cursor > width - 20) break;
    }
  };
  // Header band and fine border provide a visible scan/document frame.
  for (let y = 0; y < 62; y++) for (let x = 0; x < width; x++) pixel(x, y, y < 3 || y > 58 ? 30 : 232);
  for (let x = 18; x < width - 18; x++) { pixel(x, 16, 60); pixel(x, height - 16, 60); }
  for (let y = 16; y < height - 16; y++) { pixel(18, y, 60); pixel(width - 19, y, 60); }
  drawLine(title, 34, 22, 3);
  lines.slice(0, 7).forEach((line, index) => drawLine(line, 34, 82 + index * 36, 2));
  const encoded = jpeg.encode({ data, width, height }, 88).data;
  return { name, kind: "jpg", bytes: new Uint8Array(encoded) };
}
