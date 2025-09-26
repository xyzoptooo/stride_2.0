// AcademicDocumentParser.js
// Layer 2: Academic Document Parser for structured extraction
import { OCRProcessingError } from './ocrHelper.js';

class AcademicParserError extends Error {
  constructor(message, errorCode, context = {}) {
    super(message);
    this.name = 'AcademicParserError';
    this.errorCode = errorCode;
    this.context = context;
  }
}

const PARSING_CONFIG = {
  MIN_TEXT_LENGTH: 50,
  MAX_TEXT_LENGTH: 50000,
  COURSE_CODE_PATTERNS: [
    /[A-Z]{2,6}\s*\d{3,4}[A-Z]?/g, // CS101, MATH 201A
    /[A-Z]{2,6}-\d{3,4}/g, // CS-101, MATH-201A
  ],
  TIME_PATTERNS: [
    /\d{1,2}:\d{2}\s*[AP]M?/gi, // 2:30 PM, 14:30
    /\d{1,2}\s*[AP]M?/gi, // 2 PM, 2PM
  ],
  DAYS_OF_WEEK: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
  DATE_PATTERNS: [
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}/gi,
    /\b\d{1,2}\/\d{1,2}\/\d{4}/g, // MM/DD/YYYY
    /\b\d{4}-\d{2}-\d{2}/g, // YYYY-MM-DD
  ]
};

class AcademicDocumentParser {
  constructor(courseCode = null, courseStartDate = null) {
    this.courseCode = courseCode;
    this.courseStartDate = courseStartDate ? new Date(courseStartDate) : null;
    this.validationErrors = [];
  }

  async parseDocument(text, documentType = 'auto') {
    const startTime = Date.now();
    try {
      this._validateInput(text);
      const cleanedText = this._preprocessText(text);
      const detectedType = documentType === 'auto' ? this._detectDocumentType(cleanedText) : documentType;
      let result;
      switch (detectedType) {
        case 'syllabus':
          result = await this._parseSyllabus(cleanedText);
          break;
        case 'timetable':
          result = await this._parseTimetable(cleanedText);
          break;
        case 'assignment_sheet':
          result = await this._parseAssignmentSheet(cleanedText);
          break;
        default:
          throw new AcademicParserError(
            `Unable to determine document type: ${detectedType}`,
            'UNKNOWN_DOCUMENT_TYPE'
          );
      }
      this._validateResult(result);
      const enrichedResult = this._enrichWithContext(result);
      return {
        success: true,
        documentType: detectedType,
        data: enrichedResult,
        metadata: {
          processingTime: Date.now() - startTime,
          validationErrors: this.validationErrors,
          textLength: text.length,
          courseCodeProvided: !!this.courseCode,
          startDateProvided: !!this.courseStartDate
        }
      };
    } catch (error) {
      return {
        success: false,
        error: {
          message: error.message,
          code: error.errorCode || 'PARSING_FAILED',
          documentType: 'unknown'
        },
        metadata: {
          processingTime: Date.now() - startTime,
          textLength: text?.length || 0
        }
      };
    }
  }

  _validateInput(text) {
    if (!text || typeof text !== 'string') {
      throw new AcademicParserError('Invalid text input: must be non-empty string', 'INVALID_INPUT');
    }
    if (text.length < PARSING_CONFIG.MIN_TEXT_LENGTH) {
      throw new AcademicParserError(
        `Text too short: ${text.length} characters (minimum ${PARSING_CONFIG.MIN_TEXT_LENGTH})`,
        'TEXT_TOO_SHORT'
      );
    }
    if (text.length > PARSING_CONFIG.MAX_TEXT_LENGTH) {
      throw new AcademicParserError(
        `Text too long: ${text.length} characters (maximum ${PARSING_CONFIG.MAX_TEXT_LENGTH})`,
        'TEXT_TOO_LONG'
      );
    }
    const academicIndicators = this._findAcademicIndicators(text);
    if (academicIndicators.score < 0.3) {
      this.validationErrors.push('Text does not appear to be academic content');
    }
  }

  _preprocessText(text) {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\s+/g, ' ')
      .replace(/[^\x20-\x7E\n]/g, '')
      .trim();
  }

  _detectDocumentType(text) {
    const indicators = {
      syllabus: [
        /syllabus/i,
        /course\s*description/i,
        /learning\s*objectives/i,
        /grading\s*policy/i,
        /required\s*materials/i
      ],
      timetable: [
        /schedule/i,
        /timetable/i,
        /meeting\s*times/i,
        /class\s*schedule/i,
        /time\s*table/i
      ],
      assignment_sheet: [
        /assignment\s*\d+/i,
        /homework/i,
        /due\s*date/i,
        /submission/i,
        /problem\s*set/i
      ]
    };
    const scores = {};
    for (const [type, patterns] of Object.entries(indicators)) {
      scores[type] = patterns.reduce((score, pattern) => 
        score + (pattern.test(text) ? 1 : 0), 0
      );
    }
    const detectedType = Object.keys(scores).reduce((a, b) => 
      scores[a] > scores[b] ? a : b
    );
    return scores[detectedType] > 0 ? detectedType : 'unknown';
  }

  _parseSyllabus(text) {
    const courses = this._extractCourses(text);
    const schedule = this._extractSchedule(text);
    const assignments = this._extractAssignments(text);
    return {
      type: 'syllabus',
      courses: courses.length > 0 ? courses : this._fallbackCourseExtraction(text),
      schedule: schedule,
      assignments: assignments,
      instructors: this._extractInstructors(text),
      location: this._extractLocation(text)
    };
  }

  _parseTimetable(text) {
    const courses = this._extractCourses(text) || this._extractTimetableEntries(text);
    return {
      type: 'timetable',
      courses: courses,
      schedule: this._extractSchedule(text),
      assignments: []
    };
  }

  _parseAssignmentSheet(text) {
    const assignments = this._extractAssignments(text);
    return {
      type: 'assignment_sheet',
      courses: this.courseCode ? [{ code: this.courseCode }] : [],
      assignments: assignments,
      schedule: []
    };
  }

  _extractCourses(text) {
    const courses = [];
    PARSING_CONFIG.COURSE_CODE_PATTERNS.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          if (!courses.find(c => c.code === match.replace(/\s+/g, ''))) {
            courses.push({
              code: match.replace(/\s+/g, ''),
              name: this._extractCourseName(text, match)
            });
          }
        });
      }
    });
    return courses;
  }

  _extractSchedule(text) {
    const schedule = [];
    const lines = text.split('\n');
    lines.forEach(line => {
      const times = this._extractTimes(line);
      const days = this._extractDays(line);
      if (times.length > 0 && days.length > 0) {
        schedule.push({
          days: days,
          times: times,
          location: this._extractLocationFromLine(line)
        });
      }
    });
    return schedule;
  }

  _extractAssignments(text) {
    const assignments = [];
    const assignmentPatterns = [
      /assignment\s*(\d+)[:\-\s]+([^\.]+?)(?:due|deadline)[:\-\s]+([^\.]+)/gi,
      /homework\s*(\d+)[:\-\s]+([^\.]+?)(?:due|deadline)[:\-\s]+([^\.]+)/gi,
      /(\w+\s*\d+)[\s\-:]+([^\.]{10,100}?)(?:due|deadline)[\s\-:]+([^\.]+)/gi
    ];
    assignmentPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const dueDate = this._parseDate(match[3]);
        if (dueDate) {
          assignments.push({
            title: match[2]?.trim() || `Assignment ${match[1]}`,
            dueDate: dueDate,
            type: 'assignment',
            details: match[0].substring(0, 200)
          });
        }
      }
    });
    return assignments;
  }

  _extractTimes(text) {
    const times = [];
    PARSING_CONFIG.TIME_PATTERNS.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) times.push(...matches);
    });
    return [...new Set(times)];
  }

  _extractDays(text) {
    return PARSING_CONFIG.DAYS_OF_WEEK.filter(day => 
      new RegExp(`\\b${day}\\b`, 'i').test(text)
    );
  }

  _parseDate(dateString) {
    try {
      const date = new Date(dateString);
      return isNaN(date.getTime()) ? null : date.toISOString();
    } catch {
      return null;
    }
  }

  _validateResult(result) {
    if (!result.courses || result.courses.length === 0) {
      this.validationErrors.push('No courses detected in document');
    }
    if (result.type === 'syllabus' && result.assignments.length === 0) {
      this.validationErrors.push('Syllabus detected but no assignments found');
    }
  }

  _enrichWithContext(result) {
    if (this.courseCode && result.courses.length === 0) {
      result.courses.push({ code: this.courseCode, userProvided: true });
    }
    if (this.courseStartDate) {
      result.metadata = { ...result.metadata, courseStartDate: this.courseStartDate.toISOString() };
    }
    return result;
  }

  _findAcademicIndicators(text) {
    const academicTerms = [
      'course', 'professor', 'assignment', 'lecture', 'exam', 'quiz',
      'reading', 'homework', 'syllabus', 'schedule', 'deadline'
    ];
    const found = academicTerms.filter(term => 
      new RegExp(`\\b${term}\\b`, 'i').test(text)
    );
    return { score: found.length / academicTerms.length, terms: found };
  }

  _fallbackCourseExtraction(text) {
    return [];
  }

  _extractTimetableEntries(text) {
    return [];
  }

  _extractCourseName(text, courseCode) {
    return null;
  }

  _extractInstructors(text) {
    return [];
  }

  _extractLocation(text) {
    return null;
  }

  _extractLocationFromLine(line) {
    return null;
  }
}

export { AcademicDocumentParser, AcademicParserError };
