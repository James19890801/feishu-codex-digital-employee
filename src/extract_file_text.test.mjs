import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBufferedProcess } from './process-runner.mjs';

const python = join(
  homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime',
  'dependencies', 'python', 'bin', 'python3',
);
const extractor = join(process.cwd(), 'src', 'extract_file_text.py');
const directory = await mkdtemp(join(tmpdir(), 'aipro-extractor-'));

await runBufferedProcess(python, ['-c', `
from openpyxl import Workbook
from pptx import Presentation
from pypdf import PdfWriter
from pathlib import Path
root = Path(${JSON.stringify(directory)})
book = Workbook()
sheet = book.active
sheet.title = "经营数据"
sheet.append(["指标", "数值"])
sheet.append(["收入", 42])
book.save(root / "report.xlsx")
deck = Presentation()
slide = deck.slides.add_slide(deck.slide_layouts[1])
slide.shapes.title.text = "季度复盘"
slide.placeholders[1].text = "增长来自海外市场"
deck.save(root / "review.pptx")
writer = PdfWriter()
writer.add_blank_page(width=200, height=200)
with open(root / "scan.pdf", "wb") as output:
    writer.write(output)
`], { timeoutMs: 30_000 });

async function extract(name, options = {}) {
  const { stdout } = await runBufferedProcess(python, [extractor, join(directory, name)], {
    timeoutMs: 30_000,
    env: { ...process.env, ...options.env },
  });
  return JSON.parse(stdout);
}

const spreadsheet = await extract('report.xlsx');
assert.match(spreadsheet.text, /\[工作表：经营数据\]/);
assert.match(spreadsheet.text, /收入\t42/);

const presentation = await extract('review.pptx');
assert.match(presentation.text, /\[幻灯片 1\]/);
assert.match(presentation.text, /季度复盘/);
assert.match(presentation.text, /增长来自海外市场/);

const fakeOcr = join(directory, 'fake-ocr.py');
await writeFile(fakeOcr, '#!/usr/bin/env python3\nimport json\nprint(json.dumps({"pages":[{"page":1,"text":"扫描件识别结果"}]}, ensure_ascii=False))\n');
await chmod(fakeOcr, 0o700);
const scanned = await extract('scan.pdf', {
  env: { AIPRO_PDF_OCR_COMMAND: fakeOcr },
});
assert.match(scanned.text, /\[PDF 第 1 页 OCR\]/);
assert.match(scanned.text, /扫描件识别结果/);
assert.equal(scanned.ocrUsed, true);

console.log('EXTRACT_FILE_TEXT_TEST_OK');
