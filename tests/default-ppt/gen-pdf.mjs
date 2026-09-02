/**
 * 生成用于端到端测试的最小 PDF（2 页，每页含可辨识文本）。
 * 纯手写 PDF 结构，无需任何依赖。用法：node gen-pdf.mjs 输出路径
 */
/* eslint-env node */
import fs from 'node:fs'

const pages = [
  { text: 'PDF Slide One', note: 'one' },
  { text: 'PDF Slide Two', note: 'two' },
]

const objects = []
objects.push('<< /Type /Catalog /Pages 2 0 R >>')
objects.push('<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>')
objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 405] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>')
objects.push(`<< /Length ${pages[0].text.length + 40} >>\nstream\nBT /F1 40 Tf 72 200 Td (${pages[0].text}) Tj ET\nendstream`)
objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 405] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>')
objects.push(`<< /Length ${pages[1].text.length + 40} >>\nstream\nBT /F1 40 Tf 72 200 Td (${pages[1].text}) Tj ET\nendstream`)
objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

let pdf = '%PDF-1.4\n'
const offsets = [0]
objects.forEach((body, index) => {
  offsets.push(Buffer.byteLength(pdf))
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
})
const xrefOffset = Buffer.byteLength(pdf)
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
for (let i = 1; i <= objects.length; i++) {
  pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

fs.writeFileSync(process.argv[2], pdf, 'latin1')
console.log('written', process.argv[2], Buffer.byteLength(pdf, 'latin1'), 'bytes')
