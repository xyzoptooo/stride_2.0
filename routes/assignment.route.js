import express from 'express';
import Assignment from '../models/assignment.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../middleware/errorHandler.js';

const router = express.Router();

// Get all assignments for a user - supports both query param and path param
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

// Get all assignments for a user by supabaseId (path parameter)
router.get('/:supabaseId', async (req, res, next) => {
  try {
    const { supabaseId } = req.params;
    const { course, status } = req.query;
    
    logger.info('Fetching assignments by supabaseId', { supabaseId, course, status, path: req.path });
    
    // Check if this looks like a MongoDB ObjectId (should route to single assignment)
    if (supabaseId.match(/^[0-9a-fA-F]{24}$/)) {
      // This is a MongoDB ObjectId, fetch single assignment
      const assignment = await Assignment.findById(supabaseId);
      
      if (!assignment) {
        return res.status(404).json({ 
          status: 'error',
          message: 'Assignment not found' 
        });
      }
      
      res.setHeader('Content-Type', 'application/json');
      return res.json({
        status: 'success',
        data: assignment
      });
    }
    
    // Otherwise treat as supabaseId (UUID format)
    if (!supabaseId) {
      throw new AppError('Supabase ID is required', 400);
    }
    
    // Build query
    const query = { supabaseId };
    if (course) {
      query.course = course;
    }
    if (status === 'completed') {
      query.progress = 100;
    } else if (status === 'pending') {
      query.progress = { $lt: 100 };
    }
    
    const assignments = await Assignment.find(query)
      .sort({ dueDate: 1, createdAt: -1 })
      .populate('course', 'name');
    
    res.setHeader('Content-Type', 'application/json');
    res.json({
      status: 'success',
      results: assignments.length,
      data: { assignments }
    });
  } catch (error) {
    logger.error('Error fetching assignments by supabaseId', {
      error: error.message,
      supabaseId: req.params.supabaseId,
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
    
    // Return with normalized id field
    const responseData = savedAssignment.toObject();
    responseData.id = responseData._id;
    
    res.setHeader('Content-Type', 'application/json');
    res.status(201).json({
      status: 'success',
      ...responseData,
      _id: responseData._id,
      id: responseData._id
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
    const { title, course, dueDate, progress, reminder, notes, supabaseId } = req.body;
    
    logger.info('Updating assignment', { id, title });
    
    // Build update object
    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (course !== undefined) updateData.course = course;
    if (dueDate !== undefined) updateData.dueDate = dueDate;
    if (progress !== undefined) updateData.progress = progress;
    if (reminder !== undefined) updateData.reminder = reminder;
    if (notes !== undefined) updateData.notes = notes;
    if (supabaseId !== undefined) updateData.supabaseId = supabaseId;
    
    const updatedAssignment = await Assignment.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
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
