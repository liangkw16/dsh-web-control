import { crc32 } from 'node:zlib'

function zip(entries: Record<string, string>): Buffer {
  const files: Buffer[] = [], directory: Buffer[] = []; let offset = 0
  for (const [path, text] of Object.entries(entries)) {
    const name = Buffer.from(path), data = Buffer.from(text), header = Buffer.alloc(30), central = Buffer.alloc(46), crc = crc32(data)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42)
    files.push(header, name, data); directory.push(central, name); offset += header.length + name.length + data.length
  }
  const cd = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...files, cd, end])
}
function pdf(): Buffer {
  const stream = 'BT /F1 18 Tf 30 100 Td (Native PDF preview) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let output = '%PDF-1.4\n'; const offsets = [0]
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n` }
  const start = Buffer.byteLength(output); output += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(output)
}
export const documents: Record<string, Buffer> = {
  'fixture.txt': Buffer.from('原版文件预览\nNative text preview\n'),
  'fixture.ts': Buffer.from('export const nativePreview = "原版代码"\n'),
  'docs/fixture.md': Buffer.from('# Native Markdown\n\nOriginal document renderer.\n\n![Same folder](same.png)\n\n![Parent folder](../fixture.png)\n\n![Outside workspace](../../private.png)\n\n![External](https://example.invalid/private.png)\n'),
  'fixture.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWPwa7tLEmIY1dA2Gkp+wzVpAACi2rEQ1gbH0gAAAABJRU5ErkJggg==', 'base64'),
  'fixture.pdf': pdf(),
  'fixture.csv': Buffer.from('Native CSV,value\nname,42\n'),
  'fixture.xlsx': zip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Native" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Native XLSX</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>',
  }),
  'fixture.html': Buffer.from('<!doctype html><h1>Native HTML</h1><img src="fixture.png"><script>parent.document.body.dataset.escaped="yes";fetch("https://example.invalid/native-escape")</script>'),
  'fixture.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><text x="10" y="50">Native SVG</text><script>parent.document.body.dataset.escaped="yes"</script></svg>'),
  'fixture.docx': Buffer.from('Unsupported Office fixture; download must preserve these bytes.'),
}
