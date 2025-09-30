import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';

// Test configuration
const TEST_FILES = [
  {
    path: path.join('test', 'data', '05-versions-space.pdf'),
    type: 'application/pdf',
    name: 'test-syllabus.pdf'
  },
  {
    path: path.join('test', 'data', 'syllabus-screenshot.png'),
    type: 'image/png',
    name: 'syllabus-screenshot.png'
  }
];

async function testSyllabusImport(fileConfig) {
  try {
    console.log(`\nTesting with file: ${fileConfig.name}`);
    const fileBuffer = fs.readFileSync(fileConfig.path);

    // Create form data
    const formData = new FormData();
    formData.append('file', fileBuffer, {
      filename: fileConfig.name,
      contentType: fileConfig.type
    });

    // Send request to the endpoint
    console.log('Sending request to syllabus import endpoint...');
    const response = await axios.post('https://stride-2-0.onrender.com/api/syllabus/import', formData, {
      headers: {
        ...formData.getHeaders()
      }
    });

    console.log('Response:', JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    console.error('Test failed:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      stack: error.stack
    });
    return null;
  }
}

// Create a simple PNG with text for testing
async function createTestImage() {
  const testImagePath = path.join('test', 'data', 'syllabus-screenshot.png');
  const sampleText = `
Course: Advanced Programming CS401
Professor: Dr. Jane Smith
Office Hours: Mon/Wed 2-4pm
Email: jsmith@university.edu

Course Description:
This advanced programming course covers various topics in software development.

Assignments:
1. Project Proposal - Due: 10/15/2025
2. Midterm Exam - Due: 11/01/2025
3. Final Project - Due: 12/10/2025

Required Materials:
- Clean Code by Robert Martin
- Git version control system
- VS Code or similar IDE
`;

  // Write the sample text to a file
  fs.writeFileSync(testImagePath, sampleText);
}

// Run all tests
async function runAllTests() {
  try {
    await createTestImage();
    
    for (const fileConfig of TEST_FILES) {
      await testSyllabusImport(fileConfig);
    }
  } catch (error) {
    console.error('Test suite failed:', error);
  }
}

// Run tests
runAllTests();