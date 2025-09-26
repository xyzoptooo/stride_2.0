
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { ocrImageBuffer, extractTextFromPdfBuffer } from './ocrHelper.js';

// Rule-based extraction for assignments/courses from text
function extractAssignmentsAndCourses(text) {
  // Simple regex-based extraction (improve as needed)
  const assignmentRegex = /(assignment|quiz|exam|test|project)[^\n]*?due[^\n]*?(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/gi;
  const courseRegex = /course\s*:\s*([^\n]+)/gi;
  const assignments = [];
  let match;
  while ((match = assignmentRegex.exec(text))) {
    assignments.push({
      title: match[0].split('due')[0].trim(),
      dueDate: match[2],
    });
  }
  const courses = [];
  while ((match = courseRegex.exec(text))) {
    courses.push({ name: match[1].trim() });
  }
  return { assignments, courses };
}


// If returnRawText is true, return the extracted text instead of parsed assignments/courses
async function parseSyllabus(file, returnRawText = false) {
  let text = '';
  if (file.mimetype === 'application/pdf') {
    text = await extractTextFromPdfBuffer(file.buffer);
  } else if (
    file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    file.mimetype === 'application/msword'
  ) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    text = result.value;
  } else if (file.mimetype.startsWith('text/')) {
    text = file.buffer.toString('utf-8');
  } else if (file.mimetype.startsWith('image/')) {
    text = await ocrImageBuffer(file.buffer);
  } else {
    throw new Error('Unsupported file type');
  }
  if (returnRawText) return text;
  return extractAssignmentsAndCourses(text);
}

export { parseSyllabus };