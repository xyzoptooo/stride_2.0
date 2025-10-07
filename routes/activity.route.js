import express from 'express';
import { catchAsync } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import Activity from '../models/activity.js';
import Course from '../models/course.js';
import { authenticate } from '../middleware/auth.js';
import { validateActivity } from '../middleware/validation.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Activity routes
router.post('/', authenticate, validateActivity, catchAsync(async (req, res) => {
    logger.info('Recording new activity', { userId: req.user.supabaseId, type: req.body.type });
    const { supabaseId, type, details, title, startTime, endTime } = req.body;

    if (!supabaseId || !type) {
        throw new AppError('Missing required fields: supabaseId and type', 400);
    }

    const activityData = {
        supabaseId,
        type,
        details,
        timestamp: new Date(),
    };

    if (type.startsWith('CALENDAR_EVENT')) {
        if (!title || !startTime || !endTime) {
            throw new AppError('Missing required fields for calendar event: title, startTime, endTime', 400);
        }
        activityData.title = title;
        activityData.startTime = startTime;
        activityData.endTime = endTime;
        activityData.type = 'USER_EVENT'; // Use a generic type for user-created calendar events
    }

    const activity = await Activity.create(activityData);

    res.status(201).json({
        status: 'success',
        data: { activity }
    });
}));

router.get('/:supabaseId', authenticate, catchAsync(async (req, res) => {
    const { supabaseId } = req.params;
    const { type, startDate, endDate, course } = req.query;

    if (!supabaseId || typeof supabaseId !== 'string' || supabaseId.length < 8) {
        throw new AppError('Invalid supabaseId', 400);
    }

    // Build query
    const query = { supabaseId };
    if (type) query.type = type;
    if (course) query.course = course;

    // Date range filter
    if (startDate || endDate) {
        query.timestamp = {};
        if (startDate) query.timestamp.$gte = new Date(startDate);
        if (endDate) query.timestamp.$lte = new Date(endDate);
    }

    const activities = await Activity.find(query)
        .sort({ timestamp: -1 })
        .limit(100)
        .populate('course', 'name');

    // Format activities for frontend
    const formattedActivities = activities.map(activity => {
        if (activity.type === 'USER_EVENT') {
            return {
                id: activity._id,
                title: activity.title,
                startsAt: activity.startTime,
                endsAt: activity.endTime,
                type: activity.type,
                details: activity.details,
            };
        }
        return {
            id: activity._id,
            title: activity.type.replace(/_/g, ' '),
            startsAt: activity.timestamp,
            endsAt: activity.timestamp,
            type: activity.type,
            details: activity.details,
        };
    });

    res.status(200).json({
        status: 'success',
        results: formattedActivities.length,
        data: formattedActivities
    });
}));

router.put('/:id', authenticate, catchAsync(async (req, res) => {
    const { id } = req.params;
    const updates = req.body;

    // Validate activity exists
    const activity = await Activity.findById(id);
    if (!activity) {
        throw new AppError('Activity not found', 404);
    }

    // Validate user owns the activity
    if (updates.supabaseId && updates.supabaseId !== activity.supabaseId) {
        throw new AppError('Unauthorized: Cannot change activity ownership', 403);
    }

    // Validate course if provided
    if (updates.course) {
        const courseExists = await Course.findOne({ _id: updates.course, supabaseId: activity.supabaseId });
        if (!courseExists) {
            throw new AppError('Course not found', 404);
        }
    }

    // Validate duration if provided
    if (updates.duration !== undefined && updates.duration < 0) {
        throw new AppError('Duration cannot be negative', 400);
    }

    const updatedActivity = await Activity.findByIdAndUpdate(
        id,
        { ...updates, updatedAt: new Date() },
        { new: true, runValidators: true }
    );

    res.status(200).json({
        status: 'success',
        data: { activity: updatedActivity }
    });
}));

router.delete('/:id', authenticate, catchAsync(async (req, res) => {
    const { id } = req.params;
    const { supabaseId } = req.query;

    if (!supabaseId) {
        throw new AppError('Missing supabaseId', 400);
    }

    // Validate activity exists and user owns it
    const activity = await Activity.findOne({ _id: id, supabaseId });
    if (!activity) {
        throw new AppError('Activity not found or unauthorized', 404);
    }

    await Activity.findByIdAndDelete(id);

    res.status(200).json({
        status: 'success',
        message: 'Activity deleted successfully'
    });
}));

export default router;
