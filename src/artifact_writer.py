import json
import sys
from pathlib import Path
from docx import Document
from docx.shared import Pt


def main():
    payload = json.loads(sys.stdin.read())
    target = Path(payload['path'])
    target.parent.mkdir(parents=True, exist_ok=True)
    doc = Document()
    styles = doc.styles
    styles['Normal'].font.name = 'Arial'
    styles['Normal'].font.size = Pt(11)
    doc.add_heading(payload.get('title') or 'AI 数字分身交付物', 0)
    for raw in payload.get('content', '').splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith('### '):
            doc.add_heading(line[4:], level=3)
        elif line.startswith('## '):
            doc.add_heading(line[3:], level=2)
        elif line.startswith('# '):
            doc.add_heading(line[2:], level=1)
        elif line.startswith(('- ', '* ')):
            doc.add_paragraph(line[2:], style='List Bullet')
        elif len(line) > 2 and line[0].isdigit() and line[1] in '.、':
            doc.add_paragraph(line[2:].strip(), style='List Number')
        else:
            doc.add_paragraph(line)
    doc.save(target)
    print(target)


if __name__ == '__main__':
    main()
