import express from 'express';
import Course from '../models/course.js';

const router = express.Router();

// Get all courses for a user
router.get('/', async (req, res, next) => {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ message: 'User ID is required' });
    }
    
    const courses = await Course.find({ supabaseId: user_id });
    res.json(courses);
  } catch (error) {
    next(error);
  }
});

// Create a new course
router.post('/', async (req, res, next) => {
  try {
    const { supabaseId, name, professor, credits, schedule } = req.body;
    
    if (!supabaseId || !name) {
      return res.status(400).json({ message: 'User ID and course name are required' });
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
    res.status(201).json(savedCourse);
  } catch (error) {
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