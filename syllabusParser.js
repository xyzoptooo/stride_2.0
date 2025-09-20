const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

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

async function parseSyllabus(file) {
  let text = '';
  if (file.mimetype === 'application/pdf') {
    const data = await pdfParse(file.buffer);
    text = data.text;
  } else if (
    file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    file.mimetype === 'application/msword'
  ) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    text = result.value;
  } else if (file.mimetype.startsWith('text/')) {
    text = file.buffer.toString('utf-8');
  } else {
    throw new Error('Unsupported file type');
  }
  return extractAssignmentsAndCourses(text);
}

module.exports = { parseSyllabus };