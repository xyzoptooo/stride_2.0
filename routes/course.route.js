import express from 'express';
import Course from '../models/course.js';

const router = express.Router();

import { logger } from '../utils/logger.js';
import { AppError } from '../middleware/errorHandler.js';

// Get all courses for a user
router.get('/', async (req, res, next) => {
  try {
    const { user_id } = req.query;
    
    logger.info('Fetching courses', { user_id, path: req.path });
    
    if (!user_id) {
      throw new AppError('User ID is required', 400);
    }
    
  const query = { supabaseId: user_id };
  if (req.query.semester) query.semester = req.query.semester;
  const courses = await Course.find(query);
    
    // Set explicit content type
    res.setHeader('Content-Type', 'application/json');
    res.json({
      status: 'success',
      data: courses
    });
  } catch (error) {
    logger.error('Error fetching courses', {
      error: error.message,
      user_id: req.query.user_id,
      path: req.path
    });
    next(error);
  }
});

// Create a new course
router.post('/', async (req, res, next) => {
  try {
    const { supabaseId, name, professor, credits, schedule } = req.body;
    
    logger.info('Creating new course', { supabaseId, name });
    
    if (!supabaseId || !name) {
      throw new AppError('User ID and course name are required', 400);
    }
    
    const course = new Course({
      supabaseId,
      name,
      professor,
      credits,
      schedule,
      progress: 0
    });
    
    const savedCourse = await course.save();
    
    // Set explicit content type
    res.setHeader('Content-Type', 'application/json');
    res.status(201).json({
      status: 'success',
      data: savedCourse
    });
  } catch (error) {
    logger.error('Error creating course', {
      error: error.message,
      supabaseId: req.body.supabaseId,
      name: req.body.name,
      path: req.path
    });
    next(error);
  }
});

// Update a course
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, professor, credits, schedule, progress } = req.body;
    
    const updatedCourse = await Course.findByIdAndUpdate(
      id,
      { name, professor, credits, schedule, progress },
      { new: true }
    );
    
    if (!updatedCourse) {
      return res.status(404).json({ message: 'Course not found' });
    }
    
    res.json(updatedCourse);
  } catch (error) {
    next(error);
  }
});

// Delete a course
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const deletedCourse = await Course.findByIdAndDelete(id);
    
    if (!deletedCourse) {
      return res.status(404).json({ message: 'Course not found' });
    }
    
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;