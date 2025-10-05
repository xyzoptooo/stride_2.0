import express from 'express';
import Assignment from '../models/assignment.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../middleware/errorHandler.js';

const router = express.Router();

// Get all assignments for a user
router.get('/', async (req, res, next) => {
  try {
    const { user_id } = req.query;
    
    logger.info('Fetching assignments', { user_id, path: req.path });
    
    if (!user_id) {
      throw new AppError('User ID is required', 400);
    }
    
    const assignments = await Assignment.find({ supabaseId: user_id });
    
    res.setHeader('Content-Type', 'application/json');
    res.json({
      status: 'success',
      data: assignments
    });
  } catch (error) {
    logger.error('Error fetching assignments', {
      error: error.message,
      user_id: req.query.user_id,
      path: req.path
    });
    next(error);
  }
});

// Create a new assignment
router.post('/', async (req, res, next) => {
  try {
    const { supabaseId, title, course, dueDate, progress, reminder, notes } = req.body;
    
    logger.info('Creating new assignment', { supabaseId, title, course });
    
    if (!supabaseId || !title) {
      throw new AppError('User ID and assignment title are required', 400);
    }
    
    const assignment = new Assignment({
      supabaseId,
      title,
      course,
      dueDate,
      progress: progress || 0,
      reminder,
      notes
    });
    
    const savedAssignment = await assignment.save();
    
    res.setHeader('Content-Type', 'application/json');
    res.status(201).json({
      status: 'success',
      data: savedAssignment
    });
  } catch (error) {
    logger.error('Error creating assignment', {
      error: error.message,
      supabaseId: req.body.supabaseId,
      title: req.body.title,
      path: req.path
    });
    next(error);
  }
});

// Update an assignment
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, course, dueDate, progress, reminder, notes } = req.body;
    
    const updatedAssignment = await Assignment.findByIdAndUpdate(
      id,
      { title, course, dueDate, progress, reminder, notes },
      { new: true }
    );
    
    if (!updatedAssignment) {
      return res.status(404).json({ 
        status: 'error',
        message: 'Assignment not found' 
      });
    }
    
    res.json({
      status: 'success',
      data: updatedAssignment
    });
  } catch (error) {
    logger.error('Error updating assignment', {
      error: error.message,
      id: req.params.id,
      path: req.path
    });
    next(error);
  }
});

// Delete an assignment
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const deletedAssignment = await Assignment.findByIdAndDelete(id);
    
    if (!deletedAssignment) {
      return res.status(404).json({ 
        status: 'error',
        message: 'Assignment not found' 
      });
    }
    
    res.json({
      status: 'success',
      message: 'Assignment deleted successfully'
    });
  } catch (error) {
    logger.error('Error deleting assignment', {
      error: error.message,
      id: req.params.id,
      path: req.path
    });
    next(error);
  }
});

export default router;
