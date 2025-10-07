import express from 'express';
import { catchAsync } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import Note from '../models/note.js';
import Activity from '../models/activity.js';
import User from '../models/user.js';
import Course from '../models/course.js';
import { authenticate } from '../middleware/auth.js';
import { validateNote } from '../middleware/validation.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Note routes
router.post('/', authenticate, validateNote, catchAsync(async (req, res) => {
    const { supabaseId, title, content, tags = [], course } = req.body;

    if (!supabaseId || !content) {
        throw new AppError('Missing required fields: supabaseId and content', 400);
    }

    // Validate if user exists
    const user = await User.findOne({ supabaseId });
    if (!user) {
        throw new AppError('User not found', 404);
    }

    // Validate course if provided
    if (course) {
        const courseExists = await Course.findOne({ _id: course, supabaseId });
        if (!courseExists) {
            throw new AppError('Course not found', 404);
        }
    }

    // Validate tags
    if (!Array.isArray(tags)) {
        throw new AppError('Tags must be an array', 400);
    }

    const note = await Note.create({
        supabaseId,
        title: title || 'Untitled',
        content,
        tags,
        course,
        createdAt: new Date(),
        updatedAt: new Date()
    });

    // Log activity
    await Activity.create({
        supabaseId,
        type: 'NOTE_CREATE',
        entityId: note._id,
        details: { title: note.title, courseId: course }
    });

    res.status(201).json({
        status: 'success',
        data: { note }
    });
}));

// Get all notes for a user
router.get('/:supabaseId', async (req, res, next) => {
  try {
    const { supabaseId } = req.params;
    logger.info('Fetching notes', { supabaseId, path: req.path });
    
    if (!supabaseId) {
      throw new AppError('Supabase ID is required', 400);
    }
    
    const notes = await Note.find({ supabaseId });
    
    res.setHeader('Content-Type', 'application/json');
    res.json({
      status: 'success',
      data: notes
    });
  } catch (error) {
    logger.error('Error fetching notes', {
      error: error.message,
      supabaseId: req.params.supabaseId,
      path: req.path
    });
    next(error);
  }
});

router.put('/:id', authenticate, catchAsync(async (req, res) => {
    const { id } = req.params;
    const updates = req.body;

    // Validate note exists
    const note = await Note.findById(id);
    if (!note) {
        throw new AppError('Note not found', 404);
    }

    // Validate user owns the note
    if (updates.supabaseId && updates.supabaseId !== note.supabaseId) {
        throw new AppError('Unauthorized: Cannot change note ownership', 403);
    }

    // Validate tags if provided
    if (updates.tags && !Array.isArray(updates.tags)) {
        throw new AppError('Tags must be an array', 400);
    }

    // Validate course if provided
    if (updates.course) {
        const courseExists = await Course.findOne({ _id: updates.course, supabaseId: note.supabaseId });
        if (!courseExists) {
            throw new AppError('Course not found', 404);
        }
    }

    const updatedNote = await Note.findByIdAndUpdate(
        id,
        { ...updates, updatedAt: new Date() },
        { new: true, runValidators: true }
    );

    res.status(200).json({
        status: 'success',
        data: { note: updatedNote }
    });
}));

router.delete('/:id', authenticate, catchAsync(async (req, res) => {
    const { id } = req.params;
    const { supabaseId } = req.query;

    if (!supabaseId) {
        throw new AppError('Missing supabaseId', 400);
    }

    // Validate note exists and user owns it
    const note = await Note.findOne({ _id: id, supabaseId });
    if (!note) {
        throw new AppError('Note not found or unauthorized', 404);
    }

    await Note.findByIdAndDelete(id);

    res.status(200).json({
        status: 'success',
        message: 'Note deleted successfully'
    });
}));

export default router;
