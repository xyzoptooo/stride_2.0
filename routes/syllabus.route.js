app.post('/api/syllabus/import', upload.single('file'), async (req, res) => {
  console.log('--- /api/syllabus/import called ---');
  if (req.file) {
    console.log('File received:', req.file.originalname, req.file.mimetype, req.file.size);
  } else {
    console.log('No file received');
  }
  
  try {
    if (!req.file) {
      console.error('No file uploaded');
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Encode file as base64
    const fileBase64 = Buffer.from(req.file.buffer).toString('base64');

    // Call GPT-4 Vision API for syllabus analysis
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4-vision-preview',
      max_tokens: 4096,
      messages: [
        {
          role: 'system',
          content: 'You are an expert academic data extraction assistant. Extract information in a precise, structured format.'
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze this document and extract academic information in the following JSON structure:

{
  "courses": [{
    "name": "string",
    "code": "string",
    "professor": "string",
    "schedule": {
      "days": ["string"],
      "time": "string",
      "location": "string"
    },
    "credits": number,
    "materials": ["string"]
  }],
  "assignments": [{
    "title": "string",
    "courseCode": "string",
    "dueDate": "YYYY-MM-DD",
    "type": "string",
    "description": "string",
    "weight": number
  }],
  "importantDates": [{
    "event": "string",
    "date": "YYYY-MM-DD",
    "description": "string"
  }]
}

Extract ALL relevant information. Use null for missing values. Format dates as YYYY-MM-DD.`
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${req.file.mimetype};base64,${fileBase64}`
              }
            }
          ]
        }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.data.choices || !response.data.choices[0]?.message?.content) {
      throw new Error('Invalid response from GPT-4 Vision');
    }

    try {
      // Parse and validate the extracted data
      const extractedData = JSON.parse(response.data.choices[0].message.content);
      
      // Validate required structure
      if (!extractedData.courses || !Array.isArray(extractedData.courses) ||
          !extractedData.assignments || !Array.isArray(extractedData.assignments)) {
        throw new Error('Invalid data structure in response');
      }

      // Clean and normalize dates
      extractedData.assignments = extractedData.assignments.map(assignment => ({
        ...assignment,
        dueDate: assignment.dueDate ? new Date(assignment.dueDate).toISOString().split('T')[0] : null
      }));

      if (extractedData.importantDates) {
        extractedData.importantDates = extractedData.importantDates.map(date => ({
          ...date,
          date: date.date ? new Date(date.date).toISOString().split('T')[0] : null
        }));
      }

      // Filter out invalid entries
      extractedData.courses = extractedData.courses.filter(course => course.name);
      extractedData.assignments = extractedData.assignments.filter(assignment => 
        assignment.title && assignment.dueDate);

      res.json({
        status: 'success',
        source: 'gpt-4-vision',
        data: extractedData
      });
    } catch (parseError) {
      console.error('Failed to parse or validate GPT-4 Vision response:', parseError);
      res.status(422).json({
        status: 'error',
        source: 'gpt-4-vision',
        error: 'Failed to parse or validate extracted data',
        details: parseError.message
      });
    }
  } catch (error) {
    console.error('Error processing syllabus:', error);
    res.status(500).json({
      error: 'Failed to process syllabus',
      details: error.message
    });
  }
});